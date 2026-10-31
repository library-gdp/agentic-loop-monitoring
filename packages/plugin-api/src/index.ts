/** Plugin과 Client Adapter Daemon 사이의 인터페이스입니다. docs/002.implementation/005.PLUGIN_INTERFACE.md를 따릅니다. */

export const PLUGIN_API_VERSION = 1;

export interface PluginModule {
  /** 이 모듈을 빌드할 때 쓴 Plugin API의 PLUGIN_API_VERSION입니다. */
  readonly apiVersion: number;
  /** Daemon이 부르면 registry에 자신의 Plugin을 등록합니다. */
  register(registry: PluginRegistry): void;
}

export interface PluginRegistry {
  /** Plugin을 Collection에 등록합니다. */
  register(plugin: Plugin): void;
}

export interface Plugin {
  /** 에이전트 id입니다(예: "claude-code"). Transport Unit의 source.agent에 담깁니다. */
  readonly agent: string;
  /** Plugin의 버전입니다. Transport Unit의 source.plugin_version에 담깁니다. */
  readonly version: string;
  /** Trigger를 설정하고 수집을 시작합니다. */
  start(context: PluginContext): Promise<void>;
  /** Trigger를 해제하고 진행 중인 수집을 멈춥니다. */
  stop(): Promise<void>;
}

export interface PluginContext {
  /** Transport Unit 하나를 Daemon에 넘깁니다. */
  submit(unit: PluginTransportUnit): void;
  /** Daemon의 로그 파일에 기록합니다. */
  readonly logger: PluginLogger;
  /** Plugin 자신의 상태를 두는 디렉터리입니다. Daemon이 만들어 둡니다. */
  readonly stateDirectory: string;
  /** 설정 파일의 [plugins.<에이전트 id>] 값입니다. 없으면 빈 객체입니다. */
  readonly options: JsonObject;
}

export interface PluginLogger {
  info(message: string, details?: Readonly<Record<string, JsonValue>>): void;
  warn(message: string, details?: Readonly<Record<string, JsonValue>>): void;
  error(message: string, details?: Readonly<Record<string, JsonValue>>): void;
}

export interface PluginTransportUnit {
  readonly session: {
    /** Session ID입니다. Main Agent와 Subagent가 같은 값을 씁니다. */
    readonly id: string;
    /** 에이전트의 작업 디렉터리입니다. 알 수 없으면 뺍니다. */
    readonly cwd?: string;
  };
  readonly agent: {
    /** events를 기록한 Agent의 Agent ID입니다. */
    readonly id: string;
    /** 부모 Agent ID입니다. Main Agent이면 뺍니다. */
    readonly parent_id?: string;
  };
  readonly turn: {
    /** events가 속한 Turn을 시작한 user_message의 event_id입니다. */
    readonly id: string;
    /** events의 첫 Session Log Event의 Turn 안 위치입니다. user_message가 0입니다. */
    readonly position: number;
  };
  /** 레코드 하나에서 나온 Session Log Event입니다. 레코드 안에서 나온 순서를 따릅니다. */
  readonly events: readonly [SessionLogEvent, ...SessionLogEvent[]];
}

/** RFC 3339 형식의 시각입니다. 시간대를 포함합니다. */
export type Timestamp = string;

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type SessionLogEvent =
  | UserMessageEvent
  | ContextMessageEvent
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

export interface ContextMessageEvent extends SessionLogEventBase {
  readonly type: "context_message";
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
