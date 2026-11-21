/**
 * Turn 하나의 Session Log Event로 파생 데이터(Turn, LLM Call, Tool Call, Compaction)를 만드는 구성 규칙입니다.
 * 받는 대로 저장할 때와 파생 데이터를 모두 다시 만들 때 같은 함수를 씁니다.
 * 규칙은 docs/001.model/003.domain_model/과 docs/001.model/008.DATA_ARCHITECTURE.md를 따릅니다.
 */

import type { StopReason } from "@agentoscope/plugin-api";
import { isRecord, type Mutable, nonNegativeInteger, parseRecord } from "./json";
import type { TokenUsage, TurnStatus } from "./model";
import { parseTimestampUs } from "./time";
import { usageFromEvent } from "./usage";

/** 구성 규칙의 버전입니다. 규칙을 바꾸면 올려서 파생 데이터를 모두 다시 만들게 합니다. */
export const DERIVATION_VERSION = 1;

/** Core가 아는 Session Log Event의 type입니다. 그 밖의 type은 Activity Model을 구성할 때 쓰지 않습니다. */
export const KNOWN_EVENT_TYPES: readonly string[] = [
    "user_message",
    "assistant_message",
    "tool_result",
    "turn_interrupted",
    "compaction",
    "compaction_summary",
];

const KNOWN = new Set(KNOWN_EVENT_TYPES);
const STOP_REASONS = new Set<string>(["end_turn", "tool_use", "max_tokens", "refusal", "other"]);

/** 파생 데이터를 만드는 데 쓰는 저장된 Session Log Event 하나입니다. */
export interface TurnEventRow {
    readonly eventId: string;
    readonly position: number;
    readonly type: string;
    readonly timestampUs: number;
    /** 이 Session Log Event를 처음 저장한 수신 기록의 id입니다. */
    readonly ingestId: number;
    readonly body: string;
}

export interface DerivedLlmCall {
    readonly id: string;
    readonly position: number;
    readonly model?: string;
    readonly stopReason?: StopReason;
    readonly failed: boolean;
    readonly attempt?: number;
    readonly startedAtUs: number;
    readonly startedAtEstimated: boolean;
    readonly endedAtUs: number;
    readonly usage?: TokenUsage;
}

export interface DerivedToolCall {
    readonly llmCallId: string;
    readonly ordinal: number;
    readonly toolUseId: string;
    readonly name: string;
    readonly resultEventId?: string;
    readonly isError?: boolean;
    readonly startedAtUs: number;
    readonly endedAtUs?: number;
    readonly subagentId?: string;
}

export interface DerivedCompaction {
    readonly id: string;
    readonly position: number;
    readonly summaryEventId?: string;
    readonly trigger?: "auto" | "manual";
    readonly contextTokensBefore?: number;
    readonly model?: string;
    readonly startedAtUs: number;
    readonly endedAtUs?: number;
    readonly usage?: TokenUsage;
}

export interface DerivedTurn {
    readonly turnId: string;
    readonly status: TurnStatus;
    readonly startedAtUs: number;
    readonly endedAtUs: number;
    /** Turn을 시작한 user_message를 처음 저장한 수신 기록의 id입니다. */
    readonly ingestId: number;
    readonly llmCalls: readonly DerivedLlmCall[];
    readonly toolCalls: readonly DerivedToolCall[];
    readonly compactions: readonly DerivedCompaction[];
}

export interface DerivedTurnResult {
    readonly turn: DerivedTurn;
    /** 이 Turn의 Session Log Event 가운데 가장 먼저 받은 것의 수신 기록 id입니다. */
    readonly firstIngestId: number;
}

export interface ToolUse {
    readonly toolUseId: string;
    readonly name: string;
    readonly input: unknown;
}

/** assistant_message의 content에서 tool_use 블록을 순서대로 꺼냅니다. 배열의 index가 Tool Call의 ordinal입니다. */
export function toolUseBlocks(content: unknown): ToolUse[] {
    if (!Array.isArray(content)) return [];
    const uses: ToolUse[] = [];
    for (const block of content) {
        if (!isRecord(block) || block.type !== "tool_use") continue;
        if (typeof block.tool_use_id !== "string" || typeof block.name !== "string") continue;
        uses.push({ toolUseId: block.tool_use_id, name: block.name, input: block.input });
    }
    return uses;
}

/** Turn이 Turn 안 위치가 가장 큰 Session Log Event에서 어떻게 끝났는지입니다. */
type Ending = "final" | "manual_compaction" | "interrupted" | "stopped_by_error" | "open";

/**
 * Turn 하나의 Session Log Event로 파생 데이터를 만듭니다.
 *
 * - rows는 그 Turn의 Session Log Event를 Turn 안 위치 순으로 담습니다.
 * - Turn 안 위치 0에 이 Turn을 시작한 user_message가 없으면 Turn을 만들 수 없으므로 undefined입니다.
 * - 모르는 type의 Session Log Event는 쓰지 않습니다.
 * - status는 이 Turn의 Session Log Event만으로 정합니다. 다른 Turn을 봐야 아는 errored는 부르는 쪽이 정합니다.
 */
export function deriveTurn(
    turnId: string,
    rows: Iterable<TurnEventRow>,
): DerivedTurnResult | undefined {
    const llmCalls: DerivedLlmCall[] = [];
    const toolCalls: DerivedToolCall[] = [];
    const compactions: DerivedCompaction[] = [];
    /** 결과를 기다리는 Tool Call의 index를 tool_use_id별로 요청한 순서대로 둡니다. */
    const pendingToolCalls = new Map<string, number[]>();
    /** 아직 요약과 짝을 이루지 않은 가장 최근 Compaction의 index입니다. */
    let openCompaction: number | undefined;

    let start: TurnEventRow | undefined;
    let last: TurnEventRow | undefined;
    let ending: Ending = "open";
    let firstIngestId = Number.POSITIVE_INFINITY;

    for (const row of rows) {
        firstIngestId = Math.min(firstIngestId, row.ingestId);
        if (!KNOWN.has(row.type)) continue;
        if (row.position === 0) {
            if (start === undefined && row.type === "user_message" && row.eventId === turnId) {
                start = row;
                last = row;
            }
            continue;
        }

        const previous = last;
        last = row;
        ending = "open";

        switch (row.type) {
            case "assistant_message": {
                const event = parseRecord(row.body);
                if (event === undefined) break;
                const error = isRecord(event.error) ? event.error : undefined;
                llmCalls.push(toLlmCall(row, event, previous, error !== undefined));
                if (error !== undefined) {
                    // 오류로 끝난 LLM Call의 Loop에는 Tool Call이 없습니다.
                    if (error.will_retry === false) ending = "stopped_by_error";
                    break;
                }
                const uses = toolUseBlocks(event.content);
                uses.forEach((use, ordinal) => {
                    const index = toolCalls.length;
                    toolCalls.push({
                        llmCallId: row.eventId,
                        ordinal,
                        toolUseId: use.toolUseId,
                        name: use.name,
                        startedAtUs: row.timestampUs,
                    });
                    const pending = pendingToolCalls.get(use.toolUseId);
                    if (pending === undefined) pendingToolCalls.set(use.toolUseId, [index]);
                    else pending.push(index);
                });
                if (uses.length === 0) ending = "final";
                break;
            }
            case "tool_result": {
                const event = parseRecord(row.body);
                if (event === undefined || typeof event.tool_use_id !== "string") break;
                const index = pendingToolCalls.get(event.tool_use_id)?.shift();
                const requested = index === undefined ? undefined : toolCalls[index];
                if (index === undefined || requested === undefined) break;
                const call: Mutable<DerivedToolCall> = {
                    ...requested,
                    resultEventId: row.eventId,
                    endedAtUs: row.timestampUs,
                };
                if (typeof event.is_error === "boolean") call.isError = event.is_error;
                if (typeof event.subagent_id === "string") call.subagentId = event.subagent_id;
                toolCalls[index] = call;
                break;
            }
            case "turn_interrupted":
                ending = "interrupted";
                break;
            case "compaction": {
                const event = parseRecord(row.body) ?? {};
                const compaction: Mutable<DerivedCompaction> = {
                    id: row.eventId,
                    position: row.position,
                    startedAtUs: row.timestampUs,
                };
                if (event.trigger === "auto" || event.trigger === "manual") {
                    compaction.trigger = event.trigger;
                }
                const contextTokensBefore = nonNegativeInteger(event.context_tokens_before);
                if (contextTokensBefore !== undefined) {
                    compaction.contextTokensBefore = contextTokensBefore;
                }
                openCompaction = compactions.length;
                compactions.push(compaction);
                break;
            }
            case "compaction_summary": {
                // 요약은 바로 앞의 compaction과 짝을 이룹니다. 이미 짝이 있으면 Token Usage가 두 번
                // 더해지지 않도록 붙이지 않습니다.
                const paired =
                    openCompaction === undefined ? undefined : compactions[openCompaction];
                if (openCompaction === undefined || paired === undefined) break;
                const event = parseRecord(row.body) ?? {};
                const compaction: Mutable<DerivedCompaction> = {
                    ...paired,
                    summaryEventId: row.eventId,
                    endedAtUs: row.timestampUs,
                };
                if (typeof event.model === "string") compaction.model = event.model;
                const usage = usageFromEvent(event.usage);
                if (usage !== undefined) compaction.usage = usage;
                compactions[openCompaction] = compaction;
                openCompaction = undefined;
                if (paired.trigger === "manual") ending = "manual_compaction";
                break;
            }
            default:
                // Turn 안 위치 0이 아닌 user_message는 Activity Model을 만들지 않습니다.
                break;
        }
    }

    if (start === undefined || last === undefined) return undefined;
    return {
        turn: {
            turnId,
            status: statusOf(ending),
            startedAtUs: start.timestampUs,
            endedAtUs: last.timestampUs,
            ingestId: start.ingestId,
            llmCalls,
            toolCalls,
            compactions,
        },
        firstIngestId,
    };
}

function toLlmCall(
    row: TurnEventRow,
    event: Readonly<Record<string, unknown>>,
    previous: TurnEventRow | undefined,
    failed: boolean,
): DerivedLlmCall {
    const recordedStart =
        typeof event.started_at === "string" ? parseTimestampUs(event.started_at) : undefined;
    const call: Mutable<DerivedLlmCall> = {
        id: row.eventId,
        position: row.position,
        failed,
        startedAtUs: recordedStart ?? previous?.timestampUs ?? row.timestampUs,
        startedAtEstimated: recordedStart === undefined,
        endedAtUs: row.timestampUs,
    };
    if (typeof event.model === "string") call.model = event.model;
    if (typeof event.stop_reason === "string" && STOP_REASONS.has(event.stop_reason)) {
        call.stopReason = event.stop_reason as StopReason;
    }
    const attempt = nonNegativeInteger(event.attempt);
    if (attempt !== undefined && attempt >= 1) call.attempt = attempt;
    const usage = usageFromEvent(event.usage);
    if (usage !== undefined) call.usage = usage;
    return call;
}

function statusOf(ending: Ending): TurnStatus {
    switch (ending) {
        case "final":
        case "manual_compaction":
            return "completed";
        case "interrupted":
            return "interrupted";
        case "stopped_by_error":
            return "errored";
        case "open":
            return "in_progress";
    }
}
