/**
 * Session Log Event의 타입입니다. docs/001.model/003.domain_model/002.SESSION_LOG_EVENT.md를
 * 그대로 옮겼으며, Domain Model에 Session Log Event 종류나 필드가 더해지면 이 타입에도 더합니다.
 */

/** RFC 3339 형식의 시각입니다. 시간대를 포함합니다. */
export type Timestamp = string;

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export interface JsonObject {
    readonly [key: string]: JsonValue;
}

export type SessionLogEvent =
    | UserMessageEvent
    | AssistantMessageEvent
    | ToolResultEvent
    | TurnInterruptedEvent
    | CompactionEvent
    | CompactionSummaryEvent;

interface SessionLogEventBase {
    readonly event_id: string;
    readonly timestamp: Timestamp;
}

export interface UserMessageEvent extends SessionLogEventBase {
    readonly type: "user_message";
    readonly text: string;
}

export interface AssistantMessageEvent extends SessionLogEventBase {
    readonly type: "assistant_message";
    readonly model?: string;
    readonly content: readonly ContentBlock[];
    readonly stop_reason?: StopReason;
    readonly error?: LlmCallError;
    /** 1 이상의 정수입니다. */
    readonly attempt?: number;
    readonly usage?: TokenUsage;
    readonly started_at?: Timestamp;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface LlmCallError {
    readonly message: string;
    readonly code?: string;
    readonly status_code?: number;
    readonly will_retry?: boolean;
}

export type ContentBlock = TextBlock | ReasoningBlock | ToolUseBlock;

export interface TextBlock {
    readonly type: "text";
    readonly text: string;
}

export interface ReasoningBlock {
    readonly type: "reasoning";
    readonly text: string;
}

export interface ToolUseBlock {
    readonly type: "tool_use";
    readonly tool_use_id: string;
    readonly name: string;
    readonly input: JsonObject;
}

export interface ToolResultEvent extends SessionLogEventBase {
    readonly type: "tool_result";
    readonly tool_use_id: string;
    readonly output: string | JsonObject;
    readonly is_error?: boolean;
    readonly subagent_id?: string;
}

export interface TurnInterruptedEvent extends SessionLogEventBase {
    readonly type: "turn_interrupted";
}

export interface CompactionEvent extends SessionLogEventBase {
    readonly type: "compaction";
    readonly trigger?: "auto" | "manual";
    /** 0 이상의 정수입니다. */
    readonly context_tokens_before?: number;
}

export interface CompactionSummaryEvent extends SessionLogEventBase {
    readonly type: "compaction_summary";
    readonly text: string;
    readonly model?: string;
    readonly usage?: TokenUsage;
}

export interface TokenUsage {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_tokens?: number;
    readonly cache_write_tokens?: number;
    readonly reasoning_tokens?: number;
}
