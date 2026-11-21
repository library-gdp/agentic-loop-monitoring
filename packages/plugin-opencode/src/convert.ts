/**
 * OpenCode `event` 행 하나를 Session Log Event로 변환합니다.
 * 규칙은 docs/002.implementation/006.plugin/003.opencode/001.OVERVIEW.md의 "변환"을 따릅니다.
 *
 * 변환은 Agent(OpenCode session)마다 AgentState를 이어 가며 하고, 같은 행을 같은 AgentState에서 변환하면
 * 언제나 같은 결과가 나옵니다. 현재 시각이나 난수를 쓰지 않습니다.
 */

import type {
    ContentBlock,
    JsonObject,
    SessionLogEvent,
    StopReason,
    TokenUsage,
} from "@agentoscope/plugin-api";
import * as v from "valibot";
import {
    type AssistantInfo,
    isKnownPartType,
    messageUpdatedSchema,
    partSchemas,
    partUpdatedSchema,
    type Tokens,
    type ToolPart,
} from "./records";

/** `event` 테이블의 행입니다. */
export interface EventRow {
    readonly id: string;
    readonly seq: number;
    readonly type: string;
    readonly data: string;
}

/** 진행 중이거나 최근의 Turn입니다. */
export interface TurnState {
    /** Turn을 시작한 user_message의 event_id입니다. */
    id: string;
    /** 다음 Session Log Event의 Turn 안 위치입니다. */
    next: number;
    /** 이 Turn에 속한 OpenCode user message의 id입니다. 첫 값이 Turn을 시작한 message입니다. */
    messages: string[];
    /** 자동 compaction 뒤 OpenCode가 이어서 기록하는 user message를 이 Turn에 넣을지입니다. */
    absorbNext?: boolean;
}

/** Agent(OpenCode session) 하나의 변환 상태입니다. JSON으로 저장합니다. */
export interface AgentState {
    /** 마지막으로 수집한 `seq`입니다. 아직 수집하지 않았으면 -1입니다. */
    seq: number;
    /** 최근 Turn입니다. 마지막 값이 지금 Turn입니다. */
    turns: TurnState[];
    /** 최근에 본 user message의 id입니다. */
    users: string[];
    /** Turn을 시작하지 않는 user message(subtask command 등)의 id입니다. */
    skipped: string[];
    /** 지금 assistant message입니다. */
    assistant?: {
        id: string;
        parent: string;
        /** 이 message를 처음 기록한 행의 `seq`입니다. */
        seq: number;
        model?: string;
        created?: number;
        summary?: boolean;
    };
    /** 열려 있는 step입니다. seq는 `step-start` 행의 `seq`입니다. */
    step?: { message: string; seq: number };
    /** step을 Session Log Event로 넘긴 assistant message의 id입니다. */
    emitted: string[];
    /** error를 Session Log Event로 넘긴 assistant message의 id입니다. */
    closed: string[];
}

/** 최근 Turn을 몇 개까지 기억하는지입니다. 이전 Turn의 늦은 레코드도 그 Turn에 넣기 위해 하나보다 많이 둡니다. */
const MAX_TURNS = 4;
/** 최근 message id를 몇 개까지 기억하는지입니다. */
const MAX_IDS = 16;

export function newAgentState(): AgentState {
    return { seq: -1, turns: [], users: [], skipped: [], emitted: [], closed: [] };
}

/** 레코드 하나를 변환한 결과입니다. */
export type Conversion =
    | {
          readonly kind: "unit";
          readonly turn: { readonly id: string; readonly position: number };
          readonly events: readonly [SessionLogEvent, ...SessionLogEvent[]];
      }
    | { readonly kind: "none" }
    | { readonly kind: "invalid"; readonly reason: string };

export interface ConvertDeps {
    /**
     * 같은 session에서 fromSeq보다 크고 toSeq보다 작은 `message.part.updated.1` 행 가운데 messageId의 part를
     * part마다 마지막 기록 하나씩, 처음 기록된 순서로 돌려줍니다.
     */
    stepParts(fromSeq: number, toSeq: number, messageId: string): readonly unknown[];
}

const NONE: Conversion = { kind: "none" };

type Draft = SessionLogEvent extends infer E
    ? E extends SessionLogEvent
        ? Omit<E, "event_id">
        : never
    : never;

function remember(list: string[], id: string): void {
    if (list.includes(id)) return;
    list.push(id);
    if (list.length > MAX_IDS) list.shift();
}

function turnOf(state: AgentState, messageId: string): TurnState | undefined {
    return state.turns.find((turn) => turn.messages.includes(messageId));
}

function startTurn(state: AgentState, id: string, messageId: string): TurnState {
    const turn: TurnState = { id, next: 0, messages: [messageId] };
    state.turns.push(turn);
    if (state.turns.length > MAX_TURNS) state.turns.shift();
    return turn;
}

/** 레코드 하나에서 나온 Session Log Event에 event id를 붙입니다. 여럿이면 `<event 행 id>:<순번>`입니다. */
function eventIds(rowId: string, drafts: readonly Draft[]): SessionLogEvent[] {
    return drafts.map(
        (draft, index) =>
            ({
                event_id: drafts.length === 1 ? rowId : `${rowId}:${index}`,
                ...draft,
            }) as SessionLogEvent,
    );
}

function emit(turn: TurnState, rowId: string, drafts: readonly Draft[]): Conversion {
    const events = eventIds(rowId, drafts);
    const [first, ...rest] = events;
    if (first === undefined) return NONE;
    const conversion: Conversion = {
        kind: "unit",
        turn: { id: turn.id, position: turn.next },
        events: [first, ...rest],
    };
    turn.next += events.length;
    return conversion;
}

/** Unix epoch 밀리초를 RFC 3339(UTC) 시각으로 바꿉니다. */
export function timestamp(ms: number): string {
    return new Date(ms).toISOString();
}

function invalid(reason: string): Conversion {
    return { kind: "invalid", reason };
}

function issues(result: { issues?: readonly v.BaseIssue<unknown>[] }): string {
    return (result.issues ?? [])
        .slice(0, 3)
        .map((issue) => `${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`)
        .join("; ");
}

export function convert(row: EventRow, state: AgentState, deps: ConvertDeps): Conversion {
    if (row.type !== "message.updated.1" && row.type !== "message.part.updated.1") return NONE;
    let data: unknown;
    try {
        data = JSON.parse(row.data);
    } catch {
        return invalid("data is not JSON");
    }
    return row.type === "message.updated.1"
        ? onMessage(row, data, state, deps)
        : onPart(row, data, state, deps);
}

function onMessage(row: EventRow, data: unknown, state: AgentState, deps: ConvertDeps): Conversion {
    const parsed = v.safeParse(messageUpdatedSchema, data);
    if (!parsed.success) return invalid(`message: ${issues(parsed)}`);
    const info = parsed.output.info;
    if (info.role === "user") {
        remember(state.users, info.id);
        return NONE;
    }
    if (info.role !== "assistant") return NONE;
    const assistant = info as AssistantInfo;
    const known = state.emitted.includes(assistant.id) || state.closed.includes(assistant.id);
    if (state.assistant?.id !== assistant.id && !known) {
        state.assistant = {
            id: assistant.id,
            parent: assistant.parentID,
            seq: row.seq,
            ...(assistant.modelID ? { model: assistant.modelID } : {}),
            ...(assistant.time.created === undefined ? {} : { created: assistant.time.created }),
            ...(assistant.summary === true ? { summary: true } : {}),
        };
        if (state.step !== undefined && state.step.message !== assistant.id) delete state.step;
    }
    if (assistant.error === undefined || state.closed.includes(assistant.id)) return NONE;
    remember(state.closed, assistant.id);
    return onAssistantError(row, assistant, state, deps);
}

/** LLM 호출 오류, 출력 토큰 한도, 사용자 중단을 기록한 assistant message를 변환합니다. */
function onAssistantError(
    row: EventRow,
    info: AssistantInfo,
    state: AgentState,
    deps: ConvertDeps,
): Conversion {
    const step = state.step?.message === info.id ? state.step : undefined;
    if (step !== undefined) delete state.step;
    const turn = turnOf(state, info.parentID);
    if (turn === undefined) return NONE;
    const error = info.error;
    if (error === undefined) return NONE;
    if (info.summary === true) turn.absorbNext = false;

    const at = info.time.completed ?? info.time.created;
    if (at === undefined) return invalid("assistant message has no time");
    const content = step
        ? buildContent(deps.stepParts(step.seq, row.seq, info.id), timestamp(at))
        : { blocks: [], results: [] };
    const common = {
        type: "assistant_message" as const,
        timestamp: timestamp(at),
        ...(info.modelID ? { model: info.modelID } : {}),
        ...(info.time.created === undefined ? {} : { started_at: timestamp(info.time.created) }),
    };

    if (error.name === "MessageAbortedError") {
        const drafts: Draft[] = [];
        if (content.blocks.length > 0) {
            drafts.push({ ...common, content: content.blocks }, ...content.results);
        }
        drafts.push({ type: "turn_interrupted", timestamp: timestamp(at) });
        return emit(turn, row.id, drafts);
    }
    if (error.name === "MessageOutputLengthError") {
        if (step === undefined && state.emitted.includes(info.id)) return NONE;
        return emit(turn, row.id, [
            { ...common, content: content.blocks, stop_reason: "max_tokens" },
            ...content.results,
        ]);
    }
    const message = error.data?.message;
    const statusCode = error.data?.statusCode;
    return emit(turn, row.id, [
        {
            ...common,
            content: content.blocks,
            error: {
                message: typeof message === "string" && message !== "" ? message : error.name,
                code: error.name,
                ...(typeof statusCode === "number" && Number.isSafeInteger(statusCode)
                    ? { status_code: statusCode }
                    : {}),
                // OpenCode는 다시 시도하지 않을 때만 message에 error를 기록하고 루프를 멈춥니다.
                will_retry: false,
            },
        },
        ...content.results,
    ]);
}

function onPart(row: EventRow, data: unknown, state: AgentState, deps: ConvertDeps): Conversion {
    const parsed = v.safeParse(partUpdatedSchema, data);
    if (!parsed.success) return invalid(`part: ${issues(parsed)}`);
    const { part, time } = parsed.output;
    if (!isKnownPartType(part.type)) return NONE;
    const typed = v.safeParse(partSchemas[part.type], part);
    if (!typed.success) return invalid(`${part.type} part: ${issues(typed)}`);
    if (state.users.includes(part.messageID)) {
        return onUserPart(row, part.messageID, typed.output, time, state);
    }
    if (state.assistant?.id === part.messageID) {
        return onAssistantPart(row, typed.output, time, state, deps);
    }
    return NONE;
}

type TypedPart = v.InferOutput<(typeof partSchemas)[keyof typeof partSchemas]>;

/** user message의 part로 Turn을 시작하거나, 지금 Turn에 compaction을 넣습니다. */
function onUserPart(
    row: EventRow,
    messageId: string,
    part: TypedPart,
    time: number | undefined,
    state: AgentState,
): Conversion {
    if (turnOf(state, messageId) !== undefined || state.skipped.includes(messageId)) return NONE;
    const current = state.turns.at(-1);

    if (part.type === "compaction") {
        if (time === undefined) return invalid("compaction part has no time");
        if (part.auto === true) {
            // 자동 compaction은 Turn 도중에 일어나므로 지금 Turn에 넣습니다.
            if (current === undefined) {
                remember(state.skipped, messageId);
                return NONE;
            }
            current.messages.push(messageId);
            current.absorbNext = true;
            return emit(current, row.id, [
                { type: "compaction", trigger: "auto", timestamp: timestamp(time) },
            ]);
        }
        // 사용자가 요청한 compaction은 Turn을 시작합니다. 요청에는 글이 없습니다.
        const turn = startTurn(state, `${row.id}:0`, messageId);
        return emit(turn, row.id, [
            { type: "user_message", text: "", timestamp: timestamp(time) },
            { type: "compaction", trigger: "manual", timestamp: timestamp(time) },
        ]);
    }
    if (current?.absorbNext === true) {
        // 자동 compaction 뒤 작업을 이어 가라는 message, 또는 다시 기록한 마지막 사용자 입력입니다.
        current.messages.push(messageId);
        current.absorbNext = false;
        return NONE;
    }
    if (part.type === "subtask") {
        remember(state.skipped, messageId);
        return NONE;
    }
    if (part.type === "text" && part.synthetic !== true && part.ignored !== true) {
        if (time === undefined) return invalid("text part has no time");
        const turn = startTurn(state, row.id, messageId);
        return emit(turn, row.id, [
            { type: "user_message", text: part.text, timestamp: timestamp(time) },
        ]);
    }
    return NONE;
}

/** step의 끝에서 그 step의 part로 assistant_message와 tool_result를 만듭니다. */
function onAssistantPart(
    row: EventRow,
    part: TypedPart,
    time: number | undefined,
    state: AgentState,
    deps: ConvertDeps,
): Conversion {
    const assistant = state.assistant;
    if (assistant === undefined) return NONE;
    if (part.type === "step-start") {
        state.step = { message: assistant.id, seq: row.seq };
        return NONE;
    }
    if (part.type !== "step-finish") return NONE;
    const from = state.step?.message === assistant.id ? state.step.seq : assistant.seq;
    delete state.step;
    const turn = turnOf(state, assistant.parent);
    if (turn === undefined) return NONE;
    if (time === undefined) return invalid("step-finish part has no time");
    remember(state.emitted, assistant.id);

    const at = timestamp(time);
    const { blocks, results } = buildContent(deps.stepParts(from, row.seq, assistant.id), at);
    const usage = toUsage(part.tokens);
    const model = assistant.model ? { model: assistant.model } : {};
    if (assistant.summary === true) {
        const text = blocks
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n\n");
        return emit(turn, row.id, [
            { type: "compaction_summary", text, timestamp: at, ...model, ...usage },
        ]);
    }
    const stopReason = toStopReason(part.reason);
    return emit(turn, row.id, [
        {
            type: "assistant_message",
            timestamp: at,
            ...model,
            content: blocks,
            ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
            ...usage,
            ...(assistant.created === undefined
                ? {}
                : { started_at: timestamp(assistant.created) }),
        },
        ...results,
    ]);
}

/** OpenCode(AI SDK)의 종료 이유를 stop_reason으로 옮깁니다. */
function toStopReason(reason: string | undefined): StopReason | undefined {
    switch (reason) {
        case undefined:
            return undefined;
        case "stop":
            return "end_turn";
        case "tool-calls":
            return "tool_use";
        case "length":
            return "max_tokens";
        case "content-filter":
            return "refusal";
        default:
            return "other";
    }
}

/** OpenCode의 tokens를 Token Usage로 옮깁니다. OpenCode가 기록한 항목만 넣습니다. */
function toUsage(tokens: Tokens | undefined): { usage?: TokenUsage } {
    if (tokens === undefined) return {};
    const usage: { -readonly [K in keyof TokenUsage]: TokenUsage[K] } = {};
    if (tokens.input !== undefined) usage.input_tokens = tokens.input;
    if (tokens.output !== undefined) usage.output_tokens = tokens.output;
    if (tokens.cache?.read !== undefined) usage.cache_read_tokens = tokens.cache.read;
    if (tokens.cache?.write !== undefined) usage.cache_write_tokens = tokens.cache.write;
    if (tokens.reasoning !== undefined) usage.reasoning_tokens = tokens.reasoning;
    return Object.keys(usage).length === 0 ? {} : { usage };
}

interface Content {
    readonly blocks: ContentBlock[];
    readonly results: Draft[];
}

/** step의 part로 content 블록과 tool_result를 만듭니다. tool_result는 tool 호출 순서를 따릅니다. */
function buildContent(parts: readonly unknown[], fallback: string): Content {
    const blocks: ContentBlock[] = [];
    const results: Draft[] = [];
    for (const raw of parts) {
        const type = (raw as { type?: unknown })?.type;
        if (type === "text" || type === "reasoning") {
            const parsed = v.safeParse(partSchemas[type], raw);
            // 글이 없는 part(공급자가 추론을 암호화해 넘긴 reasoning 등)는 넣지 않습니다.
            if (parsed.success && parsed.output.text !== "") {
                blocks.push({ type, text: parsed.output.text });
            }
        } else if (type === "tool") {
            const parsed = v.safeParse(partSchemas.tool, raw);
            if (!parsed.success) continue;
            const tool = parsed.output;
            blocks.push({
                type: "tool_use",
                tool_use_id: tool.callID,
                name: tool.tool,
                input: (tool.state.input ?? {}) as JsonObject,
            });
            const result = toolResult(tool, fallback);
            if (result !== undefined) results.push(result);
        }
    }
    return { blocks, results };
}

function toolResult(tool: ToolPart, fallback: string): Draft | undefined {
    const { state } = tool;
    if (state.status !== "completed" && state.status !== "error") return undefined;
    const subagent = tool.tool === "task" ? state.metadata?.sessionId : undefined;
    return {
        type: "tool_result",
        timestamp: state.time?.end === undefined ? fallback : timestamp(state.time.end),
        tool_use_id: tool.callID,
        output: (state.status === "completed" ? state.output : state.error) ?? "",
        is_error: state.status === "error",
        ...(typeof subagent === "string" && subagent !== "" ? { subagent_id: subagent } : {}),
    };
}
