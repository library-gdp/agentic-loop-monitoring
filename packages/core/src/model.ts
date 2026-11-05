import type { LlmCallError, StopReason, TokenUsage } from "@alm/protocol";

export type TurnStatus = "completed" | "interrupted" | "errored" | "in_progress";

/** Core가 Ingest API로 받는 Transport Unit입니다. events는 Decoder가 검사를 마친 것만 담습니다. */
export interface IngestUnit {
  readonly protocolVersion: number;
  readonly transportUnitId: string;
  readonly source: {
    readonly agent: string;
    readonly pluginVersion: string;
    readonly host?: string;
  };
  readonly session: { readonly id: string; readonly cwd?: string };
  readonly agent: { readonly id: string; readonly parentId?: string };
  readonly turn: { readonly id: string; readonly position: number };
  readonly events: readonly IngestEvent[];
  /** Transport Unit의 events 수입니다. */
  readonly eventCount: number;
  /** 잘못되어 버린 Session Log Event 수입니다. */
  readonly droppedCount: number;
}

export interface IngestEvent {
  /** events 안에서의 순서입니다. 버린 Session Log Event도 순서를 차지합니다. */
  readonly index: number;
  readonly eventId: string;
  readonly type: string;
  readonly timestampUs: number;
  /** 받은 Session Log Event입니다. 모르는 필드를 포함합니다. */
  readonly body: unknown;
}

export interface TurnEventRow {
  readonly eventId: string;
  readonly position: number;
  readonly type: string;
  readonly timestampUs: number;
  readonly ingestId: number;
  readonly body: string;
}

export interface DerivedTokens {
  readonly usage?: TokenUsage;
}

export interface DerivedLlmCall extends DerivedTokens {
  readonly id: string;
  readonly position: number;
  readonly model?: string;
  readonly stopReason?: StopReason;
  readonly failed: boolean;
  readonly attempt?: number;
  readonly startedAtUs: number;
  readonly startedAtEstimated: boolean;
  readonly endedAtUs: number;
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

export interface DerivedCompaction extends DerivedTokens {
  readonly id: string;
  readonly position: number;
  readonly summaryEventId?: string;
  readonly trigger?: "auto" | "manual";
  readonly contextTokensBefore?: number;
  readonly model?: string;
  readonly startedAtUs: number;
  readonly endedAtUs?: number;
}

export interface DerivedTurn {
  readonly id: string;
  readonly status: TurnStatus;
  readonly startedAtUs: number;
  readonly endedAtUs: number;
  readonly ingestId: number;
  readonly llmCalls: readonly DerivedLlmCall[];
  readonly toolCalls: readonly DerivedToolCall[];
  readonly compactions: readonly DerivedCompaction[];
}

export interface SessionFilter {
  readonly agent?: string;
  readonly cwd?: string;
  readonly host?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface SessionSummary {
  readonly agent: string;
  readonly id: string;
  readonly cwd?: string;
  readonly host?: string;
  readonly agentCount: number;
  readonly turnCount: number;
  readonly unfinishedTurnCount: number;
  readonly firstPrompt?: string;
  readonly startedAtUs?: number;
  readonly endedAtUs?: number;
  readonly usage: TokenUsage;
}

export interface AgentSummary {
  readonly pk: number;
  readonly id: string;
  readonly parentId?: string;
  readonly turnCount: number;
  readonly startedAtUs?: number;
  readonly endedAtUs?: number;
  readonly usage: TokenUsage;
}

export interface SessionDetail extends SessionSummary {
  readonly agents: readonly AgentSummary[];
}

export interface TurnSummary {
  readonly id: string;
  readonly prompt: string;
  readonly promptTruncated: boolean;
  readonly status: TurnStatus;
  readonly startedAtUs: number;
  readonly endedAtUs: number;
  readonly loopCount: number;
  readonly toolCallCount: number;
  readonly failedLlmCallCount: number;
  readonly compactionCount: number;
  readonly usage: TokenUsage;
}

export interface ToolCallView {
  readonly ordinal: number;
  readonly id: string;
  readonly llmCallId: string;
  readonly name: string;
  readonly resultEventId?: string;
  readonly isError?: boolean;
  readonly startedAtUs: number;
  readonly endedAtUs?: number;
  readonly subagentId?: string;
  /** subagentId의 Agent입니다. 아직 받지 않았으면 비웁니다. */
  readonly subagentPk?: number;
}

export interface LlmCallView {
  readonly id: string;
  readonly position: number;
  readonly model?: string;
  readonly stopReason?: StopReason;
  readonly failed: boolean;
  readonly errorMessage?: string;
  readonly attempt?: number;
  readonly startedAtUs: number;
  readonly startedAtEstimated: boolean;
  readonly endedAtUs: number;
  readonly usage: TokenUsage;
}

export interface LoopView {
  readonly id: string;
  readonly llmCall: LlmCallView;
  readonly toolCalls: readonly ToolCallView[];
  readonly startedAtUs: number;
  readonly endedAtUs: number;
}

export interface CompactionView {
  readonly id: string;
  readonly position: number;
  readonly summaryEventId?: string;
  readonly trigger?: "auto" | "manual";
  readonly contextTokensBefore?: number;
  readonly model?: string;
  readonly startedAtUs: number;
  readonly endedAtUs?: number;
  readonly usage: TokenUsage;
}

export interface TurnDetail extends TurnSummary {
  readonly loops: readonly LoopView[];
  readonly compactions: readonly CompactionView[];
}

export interface ToolCallBody {
  readonly input?: unknown;
  readonly output?: unknown;
  readonly isError?: boolean;
}

export type { LlmCallError };
