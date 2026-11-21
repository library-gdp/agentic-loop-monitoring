/**
 * Repository API입니다. 데이터 영속화를 위한 API이며, Core가 정의하고 Persistence가 구현합니다.
 * Persistence는 데이터가 저장되는 방식만 다룹니다. Turn의 순서, 파생 데이터의 구성 규칙 같은 로직은 Core에 있습니다.
 *
 * `pk`는 저장소가 Session과 Agent에 붙인 대리 키입니다. Core는 이 값을 저장소에 다시 넘길 때만 쓰며,
 * Query API 밖으로 내보내지 않습니다.
 */

import type { DerivedTurn, TurnEventRow } from "./derive";
import type {
    Compaction,
    InputEvent,
    LlmCall,
    SessionFilter,
    SessionRef,
    TokenUsage,
    ToolCall,
    TurnStatus,
} from "./model";
import type { TurnOrderKey } from "./turn-order";

/** Agent 안에서 Turn을 가리킵니다. */
export interface TurnKey {
    readonly agentPk: number;
    readonly turnId: string;
}

export interface SessionRecord {
    readonly pk: number;
    readonly cwd?: string;
    readonly host?: string;
}

export interface AgentRecord {
    readonly pk: number;
    readonly parentId?: string;
}

/** 수신 기록입니다. stored_count는 Session Log Event를 모두 저장한 뒤에 채웁니다. */
export interface IngestRecord {
    readonly transportUnitId: string;
    readonly protocolVersion: number;
    readonly pluginVersion: string;
    readonly sessionPk: number;
    readonly agentPk: number;
    readonly receivedAtUs: number;
    readonly eventCount: number;
    readonly droppedCount: number;
}

export interface EventRecord {
    readonly sessionPk: number;
    readonly agentPk: number;
    readonly eventId: string;
    readonly turnId: string;
    readonly position: number;
    readonly type: string;
    readonly timestampUs: number;
    readonly body: string;
    readonly ingestId: number;
}

/** 쓰기 트랜잭션 안에서만 쓸 수 있는 연산입니다. */
export interface WriteTransaction {
    /** Session을 찾고, 없으면 추가합니다. */
    ensureSession(agentKind: string, sessionId: string): SessionRecord;
    /** Session의 비어 있는 필드만 채웁니다. */
    fillSession(sessionPk: number, fields: { readonly cwd?: string; readonly host?: string }): void;
    /** Agent를 찾고, 없으면 추가합니다. */
    ensureAgent(sessionPk: number, agentId: string): AgentRecord;
    /** Agent의 부모 Agent ID가 비어 있을 때만 채웁니다. */
    fillAgentParent(agentPk: number, parentId: string): void;
    /** 수신 기록을 추가하고 그 id를 돌려줍니다. */
    addIngest(record: IngestRecord): number;
    setIngestStoredCount(ingestId: number, storedCount: number): void;
    /** Session Log Event를 추가합니다. Session과 event_id가 같은 것이 이미 있으면 건너뛰고 false를 돌려줍니다. */
    addEvent(record: EventRecord): boolean;
    /** Turn의 Session Log Event를 Turn 안 위치 순으로 읽습니다. 트랜잭션이 끝나기 전에 끝까지 읽어야 합니다. */
    iterateTurnEvents(key: TurnKey): Iterable<TurnEventRow>;
    /** 같은 Agent에서 이 Turn이 아닌 Turn의 Session Log Event를 ingestId보다 나중에 받았는지 확인합니다. */
    hasOtherTurnEventReceivedAfter(key: TurnKey, ingestId: number): boolean;
    /** Turn의 파생 데이터를 지우고, turn이 있으면 다시 넣습니다. */
    replaceTurn(key: TurnKey, turn: DerivedTurn | undefined): void;
    /** 같은 Agent에서 exceptTurnId가 아닌 in_progress Turn을 errored로 바꿉니다. */
    markInProgressTurnsErrored(agentPk: number, exceptTurnId: string): void;
    /** 파생 데이터와 그 구성 규칙의 버전을 모두 지웁니다. */
    clearDerived(): void;
    setDerivationVersion(version: number): void;
}

export interface StoredSession extends SessionRef {
    readonly pk: number;
    readonly cwd?: string;
    readonly host?: string;
    /** 이 Session의 Transport Unit을 처음 받은 시각입니다. */
    readonly firstReceivedAtUs: number;
}

export interface StoredAgent {
    readonly pk: number;
    readonly agentId: string;
    readonly parentId?: string;
    /** 이 Agent의 LLM Call과 Compaction의 Token Usage 합계입니다. */
    readonly usage: TokenUsage;
}

export interface StoredTurnTime extends TurnOrderKey {
    readonly agentPk: number;
    readonly endedAtUs: number;
}

export interface StoredTurn extends TurnOrderKey {
    readonly status: TurnStatus;
    readonly endedAtUs: number;
    readonly promptPreview: string;
    readonly promptLength: number;
    readonly loopCount: number;
    readonly failedLlmCallCount: number;
    readonly toolCallCount: number;
    readonly compactionCount: number;
    readonly usage: TokenUsage;
}

export interface StoredLlmCall extends Omit<LlmCall, "error"> {
    readonly agentId: string;
    /** 오류로 끝났으면 assistant_message의 error를 JSON으로 담습니다. */
    readonly errorJson?: string;
}

export interface StoredLlmCallFilter {
    readonly agentPk?: number;
    readonly failed?: boolean;
    readonly stopReason?: string;
}

/** LLM Call의 input을 읽을 때 Turn 하나에서 읽는 범위입니다. */
export interface EventSegment {
    readonly turnId: string;
    /** 이 Turn 안 위치부터 읽습니다(포함). */
    readonly fromPosition: number;
    /** 이 Turn 안 위치 앞까지 읽습니다(제외). 없으면 Turn의 끝까지 읽습니다. */
    readonly toPosition?: number;
}

export interface Repository {
    /**
     * work를 쓰기 트랜잭션 하나로 실행합니다. 쓰기 잠금을 기다리다 시간이 지나거나 work가 예외를 던지면
     * 모두 되돌리고 예외를 던집니다.
     */
    write<T>(work: (tx: WriteTransaction) => T): T;

    /** 파생 데이터를 만든 구성 규칙의 버전입니다. 파생 데이터를 아직 만들지 않았으면 undefined입니다. */
    derivationVersion(): number | undefined;
    /** Session Log Event가 있는 Turn을 키 순서로 limit개 돌려줍니다. after가 있으면 그 뒤부터입니다. */
    listTurnKeys(after: TurnKey | undefined, limit: number): readonly TurnKey[];

    /** Session을 시작 시각(Turn이 없으면 처음 받은 시각)이 늦은 순으로 돌려줍니다. */
    listSessions(filter: SessionFilter): readonly StoredSession[];
    findSession(ref: SessionRef): StoredSession | undefined;
    findAgent(sessionPk: number, agentId: string): AgentRecord | undefined;
    listAgents(sessionPk: number): readonly StoredAgent[];
    /** Session의 모든 Turn의 시각입니다. 순서는 정하지 않습니다. */
    listTurnTimes(sessionPk: number): readonly StoredTurnTime[];
    /** Agent의 Turn입니다. 순서는 정하지 않습니다. */
    listTurns(agentPk: number, previewLength: number): readonly StoredTurn[];
    findTurn(key: TurnKey, previewLength: number): StoredTurn | undefined;
    /** Turn의 LLM Call을 Turn 안 위치 순으로 돌려줍니다. */
    listLlmCalls(key: TurnKey): readonly StoredLlmCall[];
    /** Turn의 Tool Call을 요청한 LLM Call의 Turn 안 위치와 ordinal 순으로 돌려줍니다. */
    listToolCalls(key: TurnKey): readonly ToolCall[];
    /** Turn의 Compaction을 Turn 안 위치 순으로 돌려줍니다. */
    listCompactions(key: TurnKey): readonly Compaction[];
    /** Session의 LLM Call을 끝난 시각 순으로 돌려줍니다. */
    listSessionLlmCalls(sessionPk: number, filter: StoredLlmCallFilter): readonly StoredLlmCall[];
    findLlmCall(
        agentPk: number,
        llmCallId: string,
    ): { readonly turnId: string; readonly position: number } | undefined;
    findToolCall(agentPk: number, llmCallId: string, ordinal: number): ToolCall | undefined;
    listTurnOrderKeys(agentPk: number): readonly TurnOrderKey[];
    listCompactionPositions(
        agentPk: number,
    ): readonly { readonly turnId: string; readonly position: number }[];
    /** Session Log Event의 JSON 원문입니다. */
    getEventBody(sessionPk: number, eventId: string): string | undefined;
    /**
     * Agent의 Session Log Event를 segments 순서대로, 각 segment 안에서는 Turn 안 위치 순으로 하나씩 읽습니다.
     * types에 든 type만 읽습니다. 끝까지 읽거나 return()을 불러야 읽기에 쓴 자원을 놓습니다.
     */
    iterateEvents(
        agentPk: number,
        segments: readonly EventSegment[],
        types: readonly string[],
    ): Iterable<InputEvent>;

    close(): void;
}
