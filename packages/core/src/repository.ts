import type { TokenUsage } from "@alm/protocol";
import type {
  AgentSummary,
  CompactionView,
  DerivedTurn,
  LlmCallView,
  SessionFilter,
  SessionSummary,
  ToolCallView,
  TurnEventRow,
  TurnSummary,
} from "./model";

export interface SessionRecord {
  readonly pk: number;
  readonly cwd?: string;
  readonly host?: string;
}

export interface AgentRecord {
  readonly pk: number;
  readonly parentId?: string;
}

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
  readonly body: unknown;
  readonly ingestId: number;
}

export interface TurnKey {
  readonly agentPk: number;
  readonly turnId: string;
}

/** LLM Call의 input 범위에서 Turn과 그 안의 위치입니다. */
export interface EventCursor {
  readonly turnId: string;
  readonly position: number;
  readonly startedAtUs: number;
  readonly ingestId: number;
}

/** 데이터 영속화를 위한 API입니다. Core가 정의하고 Persistence가 구현합니다. */
export interface Repository {
  /** work를 쓰기 트랜잭션 하나로 실행합니다. 예외가 나면 되돌리고 그 예외를 다시 던집니다. */
  transaction<T>(work: () => T): T;

  findOrCreateSession(agentKind: string, sessionId: string): SessionRecord;
  fillSession(pk: number, fields: { cwd?: string; host?: string }): void;
  findOrCreateAgent(sessionPk: number, agentId: string): AgentRecord;
  fillAgent(pk: number, parentId: string): void;
  insertIngest(record: IngestRecord): number;
  setIngestStoredCount(id: number, storedCount: number): void;
  /** 새로 저장했으면 true, 같은 event_id가 이미 있으면 false입니다. */
  insertEvent(record: EventRecord): boolean;

  iterateTurnEvents(key: TurnKey): Iterable<TurnEventRow>;
  hasLaterEventInOtherTurn(key: TurnKey, afterIngestId: number): boolean;
  replaceTurn(key: TurnKey, turn: DerivedTurn | undefined): void;
  markOtherInProgressTurnsErrored(key: TurnKey): void;

  derivationVersion(): number | undefined;
  clearDerived(version: number): void;
  iterateTurnKeys(): Iterable<TurnKey>;

  listSessions(filter: SessionFilter): readonly SessionSummary[];
  findSessionSummary(agentKind: string, sessionId: string): SessionSummary | undefined;
  listAgents(agentKind: string, sessionId: string): readonly AgentSummary[];
  listTurns(agentPk: number): readonly TurnSummary[];
  findTurn(key: TurnKey): TurnSummary | undefined;
  listLlmCalls(key: TurnKey): readonly LlmCallView[];
  listToolCalls(key: TurnKey): readonly ToolCallView[];
  listCompactions(key: TurnKey): readonly CompactionView[];
  findLlmCallCursor(agentPk: number, llmCallId: string): EventCursor | undefined;
  findNearestCompaction(agentPk: number, before: EventCursor): EventCursor | undefined;
  /** Agent의 Session Log Event를 Turn 순서와 position 순으로 from(포함)부터 to(제외)까지 읽습니다. */
  iterateEventBodies(
    agentPk: number,
    from: EventCursor | undefined,
    to: EventCursor,
  ): Iterable<string>;
  findEventBody(agentPk: number, eventId: string): string | undefined;
  findToolCall(
    agentPk: number,
    llmCallId: string,
    ordinal: number,
  ): { readonly toolUseId: string; readonly resultEventId?: string } | undefined;

  deleteSession(agentKind: string, sessionId: string): boolean;
}

export type { TokenUsage };
