/**
 * Agent Logging Protocol 버전 1의 Decoder입니다. Transport Unit과 Session Log Event를
 * docs/001.model/004.AGENT_LOGGING_PROTOCOL.md와 003.domain_model/002.SESSION_LOG_EVENT.md에 맞춰 검사합니다.
 *
 * 모르는 필드, 모르는 type의 Session Log Event, 모르는 content 블록은 받아들이고 원문에 남깁니다.
 * 저장할 때 STRICT 테이블이나 CHECK 제약에 걸려 Transport Unit 전체가 실패하지 않도록,
 * 그런 값을 가진 Session Log Event는 여기서 버립니다.
 */

import { type IngestEvent, type IngestRequest, parseTimestampUs } from "@agentoscope/core";
import * as v from "valibot";
import type { DecodeResult, DroppedEvent } from "./decoder";

const nonEmptyString = v.pipe(v.string(), v.minLength(1, "must not be empty"));
const safeInteger = v.pipe(v.number(), v.safeInteger());
const nonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const timestamp = v.pipe(
    v.string(),
    v.check(
        (value) => parseTimestampUs(value) !== undefined,
        "must be an RFC 3339 timestamp with a time zone",
    ),
);
/** JSON 객체입니다. looseObject는 배열도 받아들이므로 따로 검사합니다. */
const jsonObject = v.custom<Readonly<Record<string, unknown>>>(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
    "must be a JSON object",
);

const transportUnit = v.looseObject({
    protocol_version: v.literal(1),
    transport_unit_id: nonEmptyString,
    source: v.looseObject({
        agent: nonEmptyString,
        plugin_version: nonEmptyString,
        host: v.optional(v.string()),
    }),
    session: v.looseObject({
        id: nonEmptyString,
        cwd: v.optional(v.string()),
    }),
    agent: v.looseObject({
        id: nonEmptyString,
        parent_id: v.optional(nonEmptyString),
    }),
    turn: v.looseObject({
        id: nonEmptyString,
        position: nonNegativeInteger,
    }),
    events: v.pipe(v.array(v.unknown()), v.minLength(1, "must have at least one event")),
});

const tokenUsage = v.looseObject({
    input_tokens: v.optional(nonNegativeInteger),
    output_tokens: v.optional(nonNegativeInteger),
    cache_read_tokens: v.optional(nonNegativeInteger),
    cache_write_tokens: v.optional(nonNegativeInteger),
    reasoning_tokens: v.optional(nonNegativeInteger),
});

const knownContentBlocks = new Map<string, v.GenericSchema>([
    ["text", v.looseObject({ type: v.literal("text"), text: v.string() })],
    ["reasoning", v.looseObject({ type: v.literal("reasoning"), text: v.string() })],
    [
        "tool_use",
        v.looseObject({
            type: v.literal("tool_use"),
            tool_use_id: nonEmptyString,
            name: nonEmptyString,
            input: jsonObject,
        }),
    ],
]);

/** content 블록입니다. 모르는 type의 블록은 type만 검사합니다. */
const contentBlock = v.pipe(
    v.looseObject({ type: v.string() }),
    v.check((block) => {
        const schema = knownContentBlocks.get(block.type);
        return schema === undefined || v.is(schema, block);
    }, "must be a valid content block"),
);

const common = {
    event_id: nonEmptyString,
    type: nonEmptyString,
    timestamp,
};

const knownEvents = new Map<string, v.GenericSchema>([
    ["user_message", v.looseObject({ ...common, text: v.string() })],
    [
        "assistant_message",
        v.looseObject({
            ...common,
            model: v.optional(v.string()),
            content: v.array(contentBlock),
            stop_reason: v.optional(
                v.picklist(["end_turn", "tool_use", "max_tokens", "refusal", "other"]),
            ),
            error: v.optional(
                v.looseObject({
                    message: v.string(),
                    code: v.optional(v.string()),
                    status_code: v.optional(safeInteger),
                    will_retry: v.optional(v.boolean()),
                }),
            ),
            attempt: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
            usage: v.optional(tokenUsage),
            started_at: v.optional(timestamp),
        }),
    ],
    [
        "tool_result",
        v.looseObject({
            ...common,
            tool_use_id: nonEmptyString,
            output: v.union([v.string(), jsonObject], "must be a string or a JSON object"),
            is_error: v.optional(v.boolean()),
            subagent_id: v.optional(nonEmptyString),
        }),
    ],
    ["turn_interrupted", v.looseObject(common)],
    [
        "compaction",
        v.looseObject({
            ...common,
            trigger: v.optional(v.picklist(["auto", "manual"])),
            context_tokens_before: v.optional(nonNegativeInteger),
        }),
    ],
    [
        "compaction_summary",
        v.looseObject({
            ...common,
            text: v.string(),
            model: v.optional(v.string()),
            usage: v.optional(tokenUsage),
        }),
    ],
]);

/** 모르는 type의 Session Log Event입니다. 공통 필드만 검사합니다. */
const unknownEvent = v.looseObject(common);

type EventCheck =
    | { readonly ok: true; readonly event: IngestEvent }
    | { readonly ok: false; readonly dropped: DroppedEvent };

function checkEvent(value: unknown, index: number): EventCheck {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ok: false, dropped: { index, reason: "event must be a JSON object" } };
    }
    const fields = value as Readonly<Record<string, unknown>>;
    const eventId = typeof fields.event_id === "string" ? fields.event_id : undefined;
    const drop = (reason: string): EventCheck => ({
        ok: false,
        dropped: { index, ...(eventId === undefined ? {} : { eventId }), reason },
    });

    const schema =
        typeof fields.type === "string"
            ? (knownEvents.get(fields.type) ?? unknownEvent)
            : unknownEvent;
    const result = v.safeParse(schema, value);
    if (!result.success) return drop(v.summarize(result.issues));

    let body: string;
    try {
        body = JSON.stringify(value);
    } catch (error) {
        return drop(`event cannot be serialized as JSON: ${String(error)}`);
    }
    return {
        ok: true,
        event: {
            index,
            eventId: fields.event_id as string,
            type: fields.type as string,
            timestampUs: parseTimestampUs(fields.timestamp as string) as number,
            body,
        },
    };
}

/** Transport Unit을 해석합니다. protocol_version은 부르는 쪽이 이미 1인지 확인했습니다. */
export function decodeV1(value: Readonly<Record<string, unknown>>): DecodeResult {
    const parsed = v.safeParse(transportUnit, value);
    if (!parsed.success) return { ok: false, message: v.summarize(parsed.issues) };
    const unit = parsed.output;
    // 덧셈은 안전한 정수 범위를 넘으면 반올림되므로 뺄셈으로 비교합니다.
    if (unit.events.length - 1 > Number.MAX_SAFE_INTEGER - unit.turn.position) {
        return { ok: false, message: "turn.position is too large for the number of events" };
    }

    const events: IngestEvent[] = [];
    const dropped: DroppedEvent[] = [];
    unit.events.forEach((event, index) => {
        const check = checkEvent(event, index);
        if (check.ok) events.push(check.event);
        else dropped.push(check.dropped);
    });

    const request: IngestRequest = {
        protocolVersion: unit.protocol_version,
        transportUnitId: unit.transport_unit_id,
        source: {
            agentKind: unit.source.agent,
            pluginVersion: unit.source.plugin_version,
            ...(unit.source.host === undefined ? {} : { host: unit.source.host }),
        },
        session: {
            id: unit.session.id,
            ...(unit.session.cwd === undefined ? {} : { cwd: unit.session.cwd }),
        },
        agent: {
            id: unit.agent.id,
            ...(unit.agent.parent_id === undefined ? {} : { parentId: unit.agent.parent_id }),
        },
        turn: { id: unit.turn.id, position: unit.turn.position },
        eventCount: unit.events.length,
        events,
    };
    return { ok: true, request, dropped };
}
