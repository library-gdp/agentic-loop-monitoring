import { type IngestEvent, type IngestUnit, parseTimestampUs } from "@alm/core";
import { PROTOCOL_VERSION } from "@alm/protocol";
import * as v from "valibot";

const nonNegativeInteger = v.pipe(v.number(), v.integer(), v.minValue(0));
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));

const TransportUnitSchema = v.looseObject({
  protocol_version: v.pipe(v.number(), v.integer()),
  transport_unit_id: v.pipe(v.string(), v.minLength(1)),
  source: v.looseObject({
    agent: v.pipe(v.string(), v.minLength(1)),
    plugin_version: v.pipe(v.string(), v.minLength(1)),
    host: v.optional(v.string()),
  }),
  session: v.looseObject({
    id: v.pipe(v.string(), v.minLength(1)),
    cwd: v.optional(v.string()),
  }),
  agent: v.looseObject({
    id: v.pipe(v.string(), v.minLength(1)),
    parent_id: v.optional(v.string()),
  }),
  turn: v.looseObject({
    id: v.pipe(v.string(), v.minLength(1)),
    position: nonNegativeInteger,
  }),
  events: v.pipe(v.array(v.unknown()), v.minLength(1)),
});

const BaseEventSchema = v.looseObject({
  event_id: v.pipe(v.string(), v.minLength(1)),
  type: v.pipe(v.string(), v.minLength(1)),
  timestamp: v.string(),
});

const UsageSchema = v.looseObject({
  input_tokens: v.optional(nonNegativeInteger),
  output_tokens: v.optional(nonNegativeInteger),
  cache_read_tokens: v.optional(nonNegativeInteger),
  cache_write_tokens: v.optional(nonNegativeInteger),
  reasoning_tokens: v.optional(nonNegativeInteger),
});

/** 모르는 content 블록은 원문에 남기고 Core가 쓰지 않으므로, 아는 블록만 필드를 검사합니다. */
const ContentBlockSchema = v.variant("type", [
  v.looseObject({ type: v.literal("text"), text: v.string() }),
  v.looseObject({ type: v.literal("reasoning"), text: v.string() }),
  v.looseObject({
    type: v.literal("tool_use"),
    tool_use_id: v.pipe(v.string(), v.minLength(1)),
    name: v.string(),
    input: v.looseObject({}),
  }),
]);

const contentBlock = v.union([
  ContentBlockSchema,
  v.looseObject({
    type: v.pipe(
      v.string(),
      v.check((type) => !["text", "reasoning", "tool_use"].includes(type)),
    ),
  }),
]);

const EVENT_SCHEMAS: Readonly<Record<string, v.GenericSchema>> = {
  user_message: v.looseObject({ text: v.string() }),
  context_message: v.looseObject({ text: v.string() }),
  assistant_message: v.looseObject({
    model: v.optional(v.string()),
    content: v.array(contentBlock),
    stop_reason: v.optional(v.picklist(["end_turn", "tool_use", "max_tokens", "refusal", "other"])),
    error: v.optional(
      v.looseObject({
        message: v.string(),
        code: v.optional(v.string()),
        status_code: v.optional(v.pipe(v.number(), v.integer())),
        will_retry: v.optional(v.boolean()),
      }),
    ),
    attempt: v.optional(positiveInteger),
    usage: v.optional(UsageSchema),
    started_at: v.optional(
      v.pipe(
        v.string(),
        v.check((value) => parseTimestampUs(value) !== undefined),
      ),
    ),
  }),
  tool_result: v.looseObject({
    tool_use_id: v.pipe(v.string(), v.minLength(1)),
    output: v.union([v.string(), v.looseObject({})]),
    is_error: v.optional(v.boolean()),
    subagent_id: v.optional(v.string()),
  }),
  turn_interrupted: v.looseObject({}),
  compaction: v.looseObject({
    trigger: v.optional(v.picklist(["auto", "manual"])),
    context_tokens_before: v.optional(nonNegativeInteger),
  }),
  compaction_summary: v.looseObject({
    text: v.string(),
    model: v.optional(v.string()),
    usage: v.optional(UsageSchema),
  }),
};

export type DecodeResult =
  | { readonly kind: "ok"; readonly unit: IngestUnit }
  | { readonly kind: "unsupported_version"; readonly transportUnitId: string }
  | { readonly kind: "invalid"; readonly transportUnitId: string; readonly message: string };

export interface DecodeLogger {
  warn(message: string, details?: Record<string, unknown>): void;
}

function transportUnitIdOf(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const id = (input as { transport_unit_id?: unknown }).transport_unit_id;
  return typeof id === "string" ? id : "";
}

/** Agent Logging Protocol 버전 1의 Decoder입니다. */
export function decodeTransportUnit(input: unknown, logger: DecodeLogger): DecodeResult {
  const parsed = v.safeParse(TransportUnitSchema, input);
  if (!parsed.success) {
    return {
      kind: "invalid",
      transportUnitId: transportUnitIdOf(input),
      message: v.summarize(parsed.issues),
    };
  }
  const raw = parsed.output;
  if (raw.protocol_version !== PROTOCOL_VERSION) {
    return { kind: "unsupported_version", transportUnitId: raw.transport_unit_id };
  }

  const events: IngestEvent[] = [];
  raw.events.forEach((body, index) => {
    const event = decodeEvent(body, index);
    if (typeof event === "string") {
      logger.warn("dropped an invalid session log event", {
        transportUnitId: raw.transport_unit_id,
        index,
        reason: event,
      });
    } else {
      events.push(event);
    }
  });

  return {
    kind: "ok",
    unit: {
      protocolVersion: raw.protocol_version,
      transportUnitId: raw.transport_unit_id,
      source: {
        agent: raw.source.agent,
        pluginVersion: raw.source.plugin_version,
        ...(raw.source.host === undefined ? {} : { host: raw.source.host }),
      },
      session: {
        id: raw.session.id,
        ...(raw.session.cwd === undefined ? {} : { cwd: raw.session.cwd }),
      },
      agent: {
        id: raw.agent.id,
        ...(raw.agent.parent_id === undefined ? {} : { parentId: raw.agent.parent_id }),
      },
      turn: { id: raw.turn.id, position: raw.turn.position },
      events,
      eventCount: raw.events.length,
      droppedCount: raw.events.length - events.length,
    },
  };
}

function decodeEvent(body: unknown, index: number): IngestEvent | string {
  const base = v.safeParse(BaseEventSchema, body);
  if (!base.success) return v.summarize(base.issues);
  const timestampUs = parseTimestampUs(base.output.timestamp);
  if (timestampUs === undefined) return "timestamp is not RFC 3339";
  const schema = EVENT_SCHEMAS[base.output.type];
  if (schema) {
    const known = v.safeParse(schema, body);
    if (!known.success) return v.summarize(known.issues);
  }
  return {
    index,
    eventId: base.output.event_id,
    type: base.output.type,
    timestampUs,
    body,
  };
}
