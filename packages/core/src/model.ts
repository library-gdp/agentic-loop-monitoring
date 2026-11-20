/**
 * Core가 다루는 모델입니다. Activity Model의 필드는 docs/001.model/003.domain_model/을,
 * 저장 데이터의 필드는 docs/001.model/008.DATA_ARCHITECTURE.md를 따릅니다.
 * 시각은 UTC Unix epoch 마이크로초(`...Us`)입니다.
 */

import type { JsonObject, StopReason } from "@agentoscope/plugin-api";

export type TurnStatus = "completed" | "interrupted" | "errored" | "in_progress";

/** Token Usage입니다. 에이전트가 기록하지 않은 항목은 0으로 채우지 않고 비워 둡니다. */
export interface TokenUsage {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly reasoningTokens?: number;
}

// ── 식별 ──────────────────────────────────────────────────────────────

/** Session을 가리킵니다. Session은 에이전트 id와 Session ID의 조합으로 식별합니다. */
export interface SessionRef {
    /** 에이전트 id입니다. Transport Unit의 source.agent입니다. */
    readonly agentKind: string;
    readonly sessionId: string;
}

/** Agent를 가리킵니다. Agent는 Session과 Agent ID의 조합으로 식별합니다. */
export interface AgentRef extends SessionRef {
    readonly agentId: string;
}

export interface TurnRef extends AgentRef {
    readonly turnId: string;
}

export interface LlmCallRef extends AgentRef {
    readonly llmCallId: string;
}

export interface ToolCallRef extends LlmCallRef {
    /** LLM Call의 content에서 tool_use 블록의 순서입니다. 첫 블록이 0입니다. */
    readonly ordinal: number;
}

/** Session Log Event를 가리킵니다. event_id는 Session 안에서 고유합니다. */
export interface EventRef extends SessionRef {
    readonly eventId: string;
}

// ── Ingest API ────────────────────────────────────────────────────────

/** Input Adapter가 Ingest API로 넘기는 Transport Unit 하나입니다. */
export interface IngestRequest {
    readonly protocolVersion: number;
    readonly transportUnitId: string;
    readonly source: {
        readonly agentKind: string;
        readonly pluginVersion: string;
        readonly host?: string;
    };
    readonly session: {
        readonly id: string;
        readonly cwd?: string;
    };
    readonly agent: {
        readonly id: string;
        readonly parentId?: string;
    };
    readonly turn: {
        readonly id: string;
        readonly position: number;
    };
    /** Transport Unit의 events에 든 Session Log Event의 수입니다. */
    readonly eventCount: number;
    /** 검사를 통과한 Session Log Event입니다. 잘못되어 버린 것은 빠집니다. */
    readonly events: readonly IngestEvent[];
}

export interface IngestEvent {
    /** Transport Unit의 events 안에서의 순서입니다. 버린 Session Log Event도 자리를 차지합니다. */
    readonly index: number;
    readonly eventId: string;
    readonly type: string;
    readonly timestampUs: number;
    /** 받은 Session Log Event를 바꾸지 않고 직렬화한 JSON입니다. 모르는 필드도 담습니다. */
    readonly body: string;
}

export interface IngestResult {
    /** 새로 저장한 Session Log Event의 수입니다. */
    readonly storedCount: number;
    /** 잘못되어 버린 Session Log Event의 수입니다. */
    readonly droppedCount: number;
}

// ── Query API ─────────────────────────────────────────────────────────

export interface SessionFilter {
    readonly agentKind?: string;
    readonly cwd?: string;
    readonly host?: string;
    readonly limit: number;
    readonly offset: number;
}

export interface SessionSummary extends SessionRef {
    readonly cwd?: string;
    readonly host?: string;
    /** 모든 Agent의 started_at 가운데 가장 이른 시각입니다. Turn이 없으면 비웁니다. */
    readonly startedAtUs?: number;
    /** 모든 Agent의 ended_at 가운데 가장 늦은 시각입니다. Turn이 없으면 비웁니다. */
    readonly endedAtUs?: number;
    /** 이 Session의 Transport Unit을 처음 받은 시각입니다. */
    readonly firstReceivedAtUs: number;
    readonly agentCount: number;
    readonly turnCount: number;
    /** 모든 Agent의 Token Usage를 항목별로 더한 값입니다. */
    readonly usage: TokenUsage;
}

export interface AgentSummary {
    readonly agentId: string;
    /** 부모 Agent ID입니다. Main Agent이면 비웁니다. */
    readonly parentId?: string;
    readonly turnCount: number;
    /** 첫 Turn의 started_at입니다. */
    readonly startedAtUs?: number;
    /** 마지막 Turn의 ended_at입니다. */
    readonly endedAtUs?: number;
    /** 이 Agent의 모든 Turn의 Token Usage 합계입니다. Subagent의 것은 더하지 않습니다. */
    readonly usage: TokenUsage;
}

export interface SessionDetail extends SessionSummary {
    /** Main Agent와 Subagent입니다. parentId로 Agent 트리를 이룹니다. */
    readonly agents: readonly AgentSummary[];
}

export interface TurnSummary {
    readonly turnId: string;
    readonly status: TurnStatus;
    /** 프롬프트의 앞부분입니다. */
    readonly promptPreview: string;
    /** 프롬프트 전체의 길이(문자 수)입니다. */
    readonly promptLength: number;
    readonly startedAtUs: number;
    readonly endedAtUs: number;
    readonly loopCount: number;
    readonly failedLlmCallCount: number;
    readonly toolCallCount: number;
    readonly compactionCount: number;
    /** 이 Turn의 LLM Call과 Compaction의 Token Usage 합계입니다. */
    readonly usage: TokenUsage;
}

export interface LlmCallError {
    readonly message: string;
    readonly code?: string;
    readonly statusCode?: number;
    readonly willRetry?: boolean;
}

export interface LlmCall {
    readonly id: string;
    readonly turnId: string;
    /** assistant_message의 Turn 안 위치입니다. */
    readonly position: number;
    readonly model?: string;
    readonly stopReason?: StopReason;
    /** LLM 호출 오류로 끝났으면 true입니다. */
    readonly failed: boolean;
    readonly error?: LlmCallError;
    readonly attempt?: number;
    readonly startedAtUs: number;
    /** started_at을 바로 앞 Session Log Event의 시각으로 추정했으면 true입니다. */
    readonly startedAtEstimated: boolean;
    readonly endedAtUs: number;
    readonly usage?: TokenUsage;
}

export interface ToolCall {
    readonly llmCallId: string;
    readonly ordinal: number;
    /** tool_use 블록의 tool_use_id입니다. */
    readonly toolUseId: string;
    readonly name: string;
    /** tool_result의 event_id입니다. 결과가 기록되지 않았으면 비웁니다. */
    readonly resultEventId?: string;
    readonly isError?: boolean;
    readonly startedAtUs: number;
    readonly endedAtUs?: number;
    /** 이 Tool Call이 띄운 Subagent의 Agent ID입니다. */
    readonly subagentId?: string;
    /** subagentId의 Agent를 받았으면 true입니다. */
    readonly subagentRecorded: boolean;
}

/** LLM Call 하나와 그 LLM Call이 요청한 Tool Call입니다. */
export interface Loop {
    readonly id: string;
    readonly llmCall: LlmCall;
    readonly toolCalls: readonly ToolCall[];
    readonly startedAtUs: number;
    /** LLM Call과 Tool Call의 ended_at 가운데 가장 늦은 시각입니다. */
    readonly endedAtUs: number;
}

export interface Compaction {
    readonly id: string;
    readonly turnId: string;
    readonly position: number;
    /** compaction_summary의 event_id입니다. 요약이 기록되지 않았으면 비웁니다. */
    readonly summaryEventId?: string;
    readonly trigger?: "auto" | "manual";
    readonly contextTokensBefore?: number;
    readonly model?: string;
    readonly startedAtUs: number;
    readonly endedAtUs?: number;
    readonly usage?: TokenUsage;
}

export interface TurnDetail extends TurnSummary {
    /** user_message의 text 전체입니다. */
    readonly prompt: string;
    readonly loops: readonly Loop[];
    /** 일어난 순서를 따릅니다. */
    readonly compactions: readonly Compaction[];
}

export interface LlmCallFilter {
    readonly agentId?: string;
    readonly failed?: boolean;
    readonly stopReason?: StopReason;
}

export interface LlmCallListItem extends LlmCall {
    readonly agentId: string;
}

export interface ToolCallDetail extends ToolCall {
    /** tool_use 블록의 input입니다. 도구에 넘긴 인자입니다. */
    readonly input: JsonObject;
    /** tool_result의 output입니다. 결과가 기록되지 않았으면 비웁니다. */
    readonly output?: string | JsonObject;
}

/** LLM Call의 input에 든 Session Log Event 하나입니다. */
export interface InputEvent {
    readonly eventId: string;
    readonly turnId: string;
    readonly position: number;
    readonly type: string;
    readonly timestampUs: number;
    /** Session Log Event의 JSON 원문입니다. */
    readonly body: string;
}
