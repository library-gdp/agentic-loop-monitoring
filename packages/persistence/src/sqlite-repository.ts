/**
 * Core의 Repository API를 SQLite로 구현합니다. 설정과 쓰기, 읽기 절차는
 * docs/002.implementation/008.DATA_STORAGE.md를, 테이블은 009.TABLE_DEFINITION.md를 따릅니다.
 */

import { Database, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
    AgentRecord,
    Compaction,
    DerivedTurn,
    EventRecord,
    EventSegment,
    IngestRecord,
    InputEvent,
    Repository,
    SessionFilter,
    SessionRecord,
    SessionRef,
    StopReason,
    StoredAgent,
    StoredEventSlot,
    StoredLlmCall,
    StoredLlmCallFilter,
    StoredSession,
    StoredToolCallInputPreview,
    StoredToolCallResultLength,
    StoredTurn,
    StoredTurnTime,
    TokenUsage,
    ToolCall,
    TurnEventRow,
    TurnKey,
    TurnOrderKey,
    TurnStatus,
    WriteTransaction,
} from "@agentoscope/core";
import { MIGRATIONS } from "./schema";

export interface SqliteRepositoryOptions {
    /** SQLite 데이터베이스 파일의 경로입니다. 디렉터리가 없으면 권한 0700으로 만듭니다. */
    readonly path: string;
    /** 쓰기 잠금을 기다리는 최대 시간(밀리초)입니다. 넘으면 쓰기가 실패합니다. */
    readonly busyTimeoutMs: number;
}

/** 데이터베이스의 스키마 버전이 이 코드가 아는 것보다 높을 때 던집니다. */
export class UnsupportedSchemaError extends Error {
    override readonly name = "UnsupportedSchemaError";
}

/** `->`, `->>` 연산자와 STRICT 테이블에 필요한 SQLite의 최소 버전입니다. */
const MIN_SQLITE_VERSION = [3, 38, 0] as const;

/** 데이터 파일을 열고 스키마를 최신 버전으로 올립니다. */
export function openSqliteRepository(options: SqliteRepositoryOptions): SqliteRepository {
    return new SqliteRepository(options);
}

// ── SQL ───────────────────────────────────────────────────────────────

const TOKEN_COLUMNS =
    "input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens";

/** where를 만족하는 LLM Call과 Compaction의 Token Usage를 항목별로 더한 JSON 객체입니다. */
function usageSum(where: string): string {
    return `(SELECT json_object(
        'input_tokens', SUM(input_tokens), 'output_tokens', SUM(output_tokens),
        'cache_read_tokens', SUM(cache_read_tokens), 'cache_write_tokens', SUM(cache_write_tokens),
        'reasoning_tokens', SUM(reasoning_tokens))
      FROM (SELECT ${TOKEN_COLUMNS} FROM llm_call WHERE ${where}
            UNION ALL
            SELECT ${TOKEN_COLUMNS} FROM compaction WHERE ${where}))`;
}

const SESSION_SELECT = `SELECT s.pk AS pk, s.agent_kind AS agent_kind, s.session_id AS session_id,
    s.cwd AS cwd, s.host AS host,
    (SELECT MIN(i.received_at_us) FROM ingest i WHERE i.session_pk = s.pk) AS first_received_at_us
  FROM session s`;

const SQL = {
    // 쓰기
    insertSession: `INSERT INTO session (agent_kind, session_id) VALUES ($agent_kind, $session_id)
        ON CONFLICT (agent_kind, session_id) DO NOTHING`,
    selectSessionRecord: `SELECT pk, cwd, host FROM session
        WHERE agent_kind = $agent_kind AND session_id = $session_id`,
    fillSessionCwd: "UPDATE session SET cwd = $value WHERE pk = $pk AND cwd IS NULL",
    fillSessionHost: "UPDATE session SET host = $value WHERE pk = $pk AND host IS NULL",
    insertAgent: `INSERT INTO agent (session_pk, agent_id) VALUES ($session_pk, $agent_id)
        ON CONFLICT (session_pk, agent_id) DO NOTHING`,
    selectAgentRecord: `SELECT pk, parent_agent_id FROM agent
        WHERE session_pk = $session_pk AND agent_id = $agent_id`,
    fillAgentParent: `UPDATE agent SET parent_agent_id = $parent_agent_id
        WHERE pk = $pk AND parent_agent_id IS NULL`,
    insertIngest: `INSERT INTO ingest (transport_unit_id, protocol_version, plugin_version,
            session_pk, agent_pk, received_at_us, event_count, stored_count, dropped_count)
        VALUES ($transport_unit_id, $protocol_version, $plugin_version,
            $session_pk, $agent_pk, $received_at_us, $event_count, 0, $dropped_count)`,
    setIngestStoredCount: "UPDATE ingest SET stored_count = $stored_count WHERE id = $id",
    insertEvent: `INSERT INTO event (session_pk, event_id, agent_pk, turn_id, position, type,
            timestamp_us, body, ingest_id)
        VALUES ($session_pk, $event_id, $agent_pk, $turn_id, $position, $type,
            $timestamp_us, $body, $ingest_id)
        ON CONFLICT (session_pk, event_id) DO NOTHING`,
    turnEvents: `SELECT event_id, position, type, timestamp_us, ingest_id, body FROM event
        WHERE agent_pk = $agent_pk AND turn_id = $turn_id
        ORDER BY position, pk`,
    hasOtherTurnEventReceivedAfter: `SELECT EXISTS (
            SELECT 1 FROM ingest i JOIN event e ON e.ingest_id = i.id
            WHERE i.agent_pk = $agent_pk AND i.id > $ingest_id AND e.turn_id <> $turn_id
        ) AS later`,
    deleteTurnToolCalls: `DELETE FROM tool_call WHERE agent_pk = $agent_pk AND llm_call_id IN
        (SELECT llm_call_id FROM llm_call WHERE agent_pk = $agent_pk AND turn_id = $turn_id)`,
    deleteTurnLlmCalls: "DELETE FROM llm_call WHERE agent_pk = $agent_pk AND turn_id = $turn_id",
    deleteTurnCompactions:
        "DELETE FROM compaction WHERE agent_pk = $agent_pk AND turn_id = $turn_id",
    deleteTurn: "DELETE FROM turn WHERE agent_pk = $agent_pk AND turn_id = $turn_id",
    insertTurn: `INSERT INTO turn (agent_pk, turn_id, status, started_at_us, ended_at_us, ingest_id)
        VALUES ($agent_pk, $turn_id, $status, $started_at_us, $ended_at_us, $ingest_id)`,
    insertLlmCall: `INSERT INTO llm_call (agent_pk, llm_call_id, turn_id, position, model,
            stop_reason, failed, attempt, started_at_us, started_at_estimated, ended_at_us,
            ${TOKEN_COLUMNS})
        VALUES ($agent_pk, $llm_call_id, $turn_id, $position, $model,
            $stop_reason, $failed, $attempt, $started_at_us, $started_at_estimated, $ended_at_us,
            $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens,
            $reasoning_tokens)`,
    insertToolCall: `INSERT INTO tool_call (agent_pk, llm_call_id, ordinal, tool_use_id, name,
            result_event_id, is_error, started_at_us, ended_at_us, subagent_id)
        VALUES ($agent_pk, $llm_call_id, $ordinal, $tool_use_id, $name,
            $result_event_id, $is_error, $started_at_us, $ended_at_us, $subagent_id)`,
    insertCompaction: `INSERT INTO compaction (agent_pk, compaction_id, turn_id, position,
            summary_event_id, trigger, context_tokens_before, model, started_at_us, ended_at_us,
            ${TOKEN_COLUMNS})
        VALUES ($agent_pk, $compaction_id, $turn_id, $position,
            $summary_event_id, $trigger, $context_tokens_before, $model, $started_at_us,
            $ended_at_us, $input_tokens, $output_tokens, $cache_read_tokens,
            $cache_write_tokens, $reasoning_tokens)`,
    markInProgressTurnsErrored: `UPDATE turn SET status = 'errored'
        WHERE agent_pk = $agent_pk AND status = 'in_progress' AND turn_id <> $turn_id`,
    clearDerived: `DELETE FROM tool_call; DELETE FROM llm_call; DELETE FROM compaction;
        DELETE FROM turn; DELETE FROM derivation;`,
    setDerivationVersion: `INSERT INTO derivation (id, version) VALUES (1, $version)
        ON CONFLICT (id) DO UPDATE SET version = excluded.version`,

    // 파생 데이터 관리
    derivationVersion: "SELECT version FROM derivation WHERE id = 1",
    turnKeys: `SELECT DISTINCT agent_pk, turn_id FROM event
        WHERE (agent_pk, turn_id) > ($agent_pk, $turn_id)
        ORDER BY agent_pk, turn_id
        LIMIT $limit`,

    // 읽기
    listSessions: `SELECT * FROM (${SESSION_SELECT}
            WHERE ($agent_kind IS NULL OR s.agent_kind = $agent_kind)
              AND ($cwd IS NULL OR s.cwd = $cwd)
              AND ($host IS NULL OR s.host = $host)) AS listed
        ORDER BY COALESCE(
            (SELECT MIN(t.started_at_us) FROM agent a JOIN turn t ON t.agent_pk = a.pk
              WHERE a.session_pk = listed.pk),
            listed.first_received_at_us) DESC, listed.pk DESC
        LIMIT $limit OFFSET $offset`,
    findSession: `${SESSION_SELECT} WHERE s.agent_kind = $agent_kind AND s.session_id = $session_id`,
    findAgent: `SELECT pk, parent_agent_id FROM agent
        WHERE session_pk = $session_pk AND agent_id = $agent_id`,
    listAgents: `SELECT a.pk AS pk, a.agent_id AS agent_id, a.parent_agent_id AS parent_agent_id,
            ${usageSum("agent_pk = a.pk")} AS usage
        FROM agent a WHERE a.session_pk = $session_pk ORDER BY a.pk`,
    listTurnTimes: `SELECT t.agent_pk AS agent_pk, t.turn_id AS turn_id,
            t.started_at_us AS started_at_us, t.ended_at_us AS ended_at_us, t.ingest_id AS ingest_id
        FROM turn t JOIN agent a ON a.pk = t.agent_pk WHERE a.session_pk = $session_pk`,
    listTurnOrderKeys:
        "SELECT turn_id, started_at_us, ingest_id FROM turn WHERE agent_pk = $agent_pk",
    findLlmCall: `SELECT turn_id, position FROM llm_call
        WHERE agent_pk = $agent_pk AND llm_call_id = $llm_call_id`,
    listCompactionPositions: "SELECT turn_id, position FROM compaction WHERE agent_pk = $agent_pk",
    listCompactions: `SELECT compaction_id, turn_id, position, summary_event_id, trigger,
            context_tokens_before, model, started_at_us, ended_at_us, ${TOKEN_COLUMNS}
        FROM compaction WHERE agent_pk = $agent_pk AND turn_id = $turn_id ORDER BY position`,
    getEventBody: "SELECT body FROM event WHERE session_pk = $session_pk AND event_id = $event_id",
    segmentEvents: `SELECT event_id, turn_id, position, type, timestamp_us, body FROM event
        WHERE agent_pk = $agent_pk AND turn_id = $turn_id
          AND position >= $from_position AND position < $to_position
          AND type IN (SELECT value FROM json_each($types))
        ORDER BY position, pk`,
} as const;

const TURN_SELECT = `SELECT t.turn_id AS turn_id, t.status AS status,
    t.started_at_us AS started_at_us, t.ended_at_us AS ended_at_us, t.ingest_id AS ingest_id,
    substr(p.body ->> '$.text', 1, $preview_length) AS prompt_preview,
    length(p.body ->> '$.text') AS prompt_length,
    (SELECT COUNT(*) FROM llm_call l
      WHERE l.agent_pk = t.agent_pk AND l.turn_id = t.turn_id) AS loop_count,
    (SELECT COUNT(*) FROM llm_call l
      WHERE l.agent_pk = t.agent_pk AND l.turn_id = t.turn_id AND l.failed = 1)
      AS failed_llm_call_count,
    (SELECT COUNT(*) FROM tool_call c WHERE c.agent_pk = t.agent_pk AND c.llm_call_id IN
      (SELECT l.llm_call_id FROM llm_call l
        WHERE l.agent_pk = t.agent_pk AND l.turn_id = t.turn_id)) AS tool_call_count,
    (SELECT COUNT(*) FROM compaction c
      WHERE c.agent_pk = t.agent_pk AND c.turn_id = t.turn_id) AS compaction_count,
    ${usageSum("agent_pk = t.agent_pk AND turn_id = t.turn_id")} AS usage
  FROM turn t
  LEFT JOIN event p ON p.agent_pk = t.agent_pk AND p.turn_id = t.turn_id
    AND p.position = 0 AND p.event_id = t.turn_id`;

const LLM_CALL_SELECT = `SELECT a.agent_id AS agent_id, l.llm_call_id AS llm_call_id,
    l.turn_id AS turn_id, l.position AS position, l.model AS model, l.stop_reason AS stop_reason,
    l.failed AS failed, l.attempt AS attempt, l.started_at_us AS started_at_us,
    l.started_at_estimated AS started_at_estimated, l.ended_at_us AS ended_at_us,
    l.input_tokens AS input_tokens, l.output_tokens AS output_tokens,
    l.cache_read_tokens AS cache_read_tokens, l.cache_write_tokens AS cache_write_tokens,
    l.reasoning_tokens AS reasoning_tokens,
    CASE WHEN l.failed = 1 THEN (SELECT e.body -> '$.error' FROM event e
      WHERE e.session_pk = a.session_pk AND e.event_id = l.llm_call_id) END AS error_json
  FROM llm_call l JOIN agent a ON a.pk = l.agent_pk`;

const TOOL_CALL_COLUMNS = `c.llm_call_id AS llm_call_id, c.ordinal AS ordinal,
    c.tool_use_id AS tool_use_id, c.name AS name, c.result_event_id AS result_event_id,
    c.is_error AS is_error, c.started_at_us AS started_at_us, c.ended_at_us AS ended_at_us,
    c.subagent_id AS subagent_id,
    c.subagent_id IS NOT NULL AND EXISTS (SELECT 1 FROM agent s
      WHERE s.session_pk = a.session_pk AND s.agent_id = c.subagent_id) AS subagent_recorded`;

const READ_SQL = {
    listTurns: `${TURN_SELECT} WHERE t.agent_pk = $agent_pk`,
    findTurn: `${TURN_SELECT} WHERE t.agent_pk = $agent_pk AND t.turn_id = $turn_id`,
    listLlmCalls: `${LLM_CALL_SELECT}
        WHERE l.agent_pk = $agent_pk AND l.turn_id = $turn_id ORDER BY l.position`,
    listSessionLlmCalls: `${LLM_CALL_SELECT}
        WHERE a.session_pk = $session_pk
          AND ($agent_pk IS NULL OR l.agent_pk = $agent_pk)
          AND ($failed IS NULL OR l.failed = $failed)
          AND ($stop_reason IS NULL OR l.stop_reason = $stop_reason)
        ORDER BY l.ended_at_us, l.agent_pk, l.position`,
    // CROSS JOIN으로 Turn의 LLM Call에서 시작해 Agent의 Tool Call 전체를 훑지 않게 합니다.
    listToolCalls: `SELECT ${TOOL_CALL_COLUMNS}
        FROM llm_call l
        CROSS JOIN tool_call c ON c.agent_pk = l.agent_pk AND c.llm_call_id = l.llm_call_id
        JOIN agent a ON a.pk = l.agent_pk
        WHERE l.agent_pk = $agent_pk AND l.turn_id = $turn_id
        ORDER BY l.position, c.ordinal`,
    // Turn의 Node 메타데이터(docs/002.implementation/008.DATA_STORAGE.md). 모두 event_by_turn으로 그 Turn만 읽습니다.
    listTurnEventSlots: `SELECT position, type, event_id, timestamp_us FROM event
        WHERE agent_pk = $agent_pk AND turn_id = $turn_id
        ORDER BY position, pk`,
    // tool_use 블록의 순서가 ordinal입니다. Core의 toolUseBlocks처럼 tool_use_id와 name이 문자열인 블록만 셉니다.
    // 객체가 아닌 블록에 JSON 함수를 쓰지 않도록 CASE로 막습니다.
    listToolCallInputPreviews: `SELECT llm_call_id, ordinal,
            substr(input, 1, $preview_length) AS input_preview, length(input) AS input_length
        FROM (SELECT e.event_id AS llm_call_id,
                row_number() OVER (PARTITION BY e.pk ORDER BY b.key) - 1 AS ordinal,
                b.value -> '$.input' AS input
            FROM event AS e, json_each(e.body, '$.content') AS b
            WHERE e.agent_pk = $agent_pk AND e.turn_id = $turn_id
              AND e.type = 'assistant_message'
              AND json_type(e.body, '$.content') = 'array'
              AND CASE WHEN b.type = 'object' THEN
                    b.value ->> '$.type' = 'tool_use'
                    AND json_type(b.value, '$.tool_use_id') = 'text'
                    AND json_type(b.value, '$.name') = 'text'
                  ELSE 0 END)`,
    // output이 문자열이면 그 문자 수, 그 밖이면 JSON 텍스트의 문자 수입니다.
    listToolCallResultLengths: `SELECT t.llm_call_id AS llm_call_id, t.ordinal AS ordinal,
            CASE json_type(r.body, '$.output')
              WHEN 'text' THEN length(r.body ->> '$.output')
              ELSE length(r.body -> '$.output')
            END AS result_length
        FROM llm_call AS l
        CROSS JOIN tool_call AS t ON t.agent_pk = l.agent_pk AND t.llm_call_id = l.llm_call_id
        JOIN event AS r ON r.session_pk = $session_pk AND r.event_id = t.result_event_id
        WHERE l.agent_pk = $agent_pk AND l.turn_id = $turn_id`,
    findToolCall: `SELECT ${TOOL_CALL_COLUMNS}
        FROM tool_call c JOIN agent a ON a.pk = c.agent_pk
        WHERE c.agent_pk = $agent_pk AND c.llm_call_id = $llm_call_id AND c.ordinal = $ordinal`,
} as const;

// ── 행 ────────────────────────────────────────────────────────────────

type Nullable<T> = { readonly [K in keyof T]: T[K] | null };

interface TokenColumns {
    readonly input_tokens: number | null;
    readonly output_tokens: number | null;
    readonly cache_read_tokens: number | null;
    readonly cache_write_tokens: number | null;
    readonly reasoning_tokens: number | null;
}

interface SessionRow {
    readonly pk: number;
    readonly agent_kind: string;
    readonly session_id: string;
    readonly cwd: string | null;
    readonly host: string | null;
    readonly first_received_at_us: number;
}

interface TurnRow {
    readonly turn_id: string;
    readonly status: TurnStatus;
    readonly started_at_us: number;
    readonly ended_at_us: number;
    readonly ingest_id: number;
    readonly prompt_preview: string | null;
    readonly prompt_length: number | null;
    readonly loop_count: number;
    readonly failed_llm_call_count: number;
    readonly tool_call_count: number;
    readonly compaction_count: number;
    readonly usage: string;
}

interface LlmCallRow extends TokenColumns {
    readonly agent_id: string;
    readonly llm_call_id: string;
    readonly turn_id: string;
    readonly position: number;
    readonly model: string | null;
    readonly stop_reason: StopReason | null;
    readonly failed: number;
    readonly attempt: number | null;
    readonly started_at_us: number;
    readonly started_at_estimated: number;
    readonly ended_at_us: number;
    readonly error_json: string | null;
}

interface ToolCallRow {
    readonly llm_call_id: string;
    readonly ordinal: number;
    readonly tool_use_id: string;
    readonly name: string;
    readonly result_event_id: string | null;
    readonly is_error: number | null;
    readonly started_at_us: number;
    readonly ended_at_us: number | null;
    readonly subagent_id: string | null;
    readonly subagent_recorded: number;
}

interface CompactionRow extends TokenColumns {
    readonly compaction_id: string;
    readonly turn_id: string;
    readonly position: number;
    readonly summary_event_id: string | null;
    readonly trigger: "auto" | "manual" | null;
    readonly context_tokens_before: number | null;
    readonly model: string | null;
    readonly started_at_us: number;
    readonly ended_at_us: number | null;
}

interface EventRow {
    readonly event_id: string;
    readonly turn_id: string;
    readonly position: number;
    readonly type: string;
    readonly timestamp_us: number;
    readonly body: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** 값이 null이 아닌 속성만 담은 객체를 만듭니다. */
function present<T extends object>(values: Nullable<T>): T {
    const result: Partial<Mutable<T>> = {};
    for (const [key, value] of Object.entries(values)) {
        if (value !== null) (result as Record<string, unknown>)[key] = value;
    }
    return result as T;
}

function usageFromColumns(row: TokenColumns): TokenUsage {
    return present<TokenUsage>({
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        reasoningTokens: row.reasoning_tokens,
    });
}

function usageFromSum(json: string): TokenUsage {
    const sum = JSON.parse(json) as TokenColumns;
    return usageFromColumns(sum);
}

function optionalUsage(row: TokenColumns): TokenUsage | undefined {
    const usage = usageFromColumns(row);
    return Object.keys(usage).length > 0 ? usage : undefined;
}

function toStoredSession(row: SessionRow): StoredSession {
    return {
        pk: row.pk,
        agentKind: row.agent_kind,
        sessionId: row.session_id,
        firstReceivedAtUs: row.first_received_at_us,
        ...present({ cwd: row.cwd, host: row.host }),
    };
}

function toStoredTurn(row: TurnRow): StoredTurn {
    return {
        turnId: row.turn_id,
        status: row.status,
        startedAtUs: row.started_at_us,
        endedAtUs: row.ended_at_us,
        ingestId: row.ingest_id,
        promptPreview: row.prompt_preview ?? "",
        promptLength: row.prompt_length ?? 0,
        loopCount: row.loop_count,
        failedLlmCallCount: row.failed_llm_call_count,
        toolCallCount: row.tool_call_count,
        compactionCount: row.compaction_count,
        usage: usageFromSum(row.usage),
    };
}

function toStoredLlmCall(row: LlmCallRow): StoredLlmCall {
    const usage = optionalUsage(row);
    return {
        agentId: row.agent_id,
        id: row.llm_call_id,
        turnId: row.turn_id,
        position: row.position,
        failed: row.failed === 1,
        startedAtUs: row.started_at_us,
        startedAtEstimated: row.started_at_estimated === 1,
        endedAtUs: row.ended_at_us,
        ...present({
            model: row.model,
            stopReason: row.stop_reason,
            attempt: row.attempt,
            errorJson: row.error_json,
        }),
        ...(usage === undefined ? {} : { usage }),
    };
}

function toToolCall(row: ToolCallRow): ToolCall {
    return {
        llmCallId: row.llm_call_id,
        ordinal: row.ordinal,
        toolUseId: row.tool_use_id,
        name: row.name,
        startedAtUs: row.started_at_us,
        subagentRecorded: row.subagent_recorded === 1,
        ...present({
            resultEventId: row.result_event_id,
            isError: row.is_error === null ? null : row.is_error === 1,
            endedAtUs: row.ended_at_us,
            subagentId: row.subagent_id,
        }),
    };
}

function toCompaction(row: CompactionRow): Compaction {
    const usage = optionalUsage(row);
    return {
        id: row.compaction_id,
        turnId: row.turn_id,
        position: row.position,
        startedAtUs: row.started_at_us,
        ...present({
            summaryEventId: row.summary_event_id,
            trigger: row.trigger,
            contextTokensBefore: row.context_tokens_before,
            model: row.model,
            endedAtUs: row.ended_at_us,
        }),
        ...(usage === undefined ? {} : { usage }),
    };
}

function tokenParams(usage: TokenUsage | undefined): TokenColumns {
    return {
        input_tokens: usage?.inputTokens ?? null,
        output_tokens: usage?.outputTokens ?? null,
        cache_read_tokens: usage?.cacheReadTokens ?? null,
        cache_write_tokens: usage?.cacheWriteTokens ?? null,
        reasoning_tokens: usage?.reasoningTokens ?? null,
    };
}

function booleanParam(value: boolean | undefined): number | null {
    return value === undefined ? null : value ? 1 : 0;
}

// ── Repository ────────────────────────────────────────────────────────

export class SqliteRepository implements Repository {
    readonly #path: string;
    readonly #busyTimeoutMs: number;
    readonly #db: Database;
    readonly #tx: WriteTransaction;
    #closed = false;

    constructor(options: SqliteRepositoryOptions) {
        this.#path = options.path;
        this.#busyTimeoutMs = options.busyTimeoutMs;
        mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
        this.#db = new Database(options.path, { create: true, readwrite: true, strict: true });
        try {
            checkSqliteVersion(this.#db);
            this.#db.exec("PRAGMA journal_mode = WAL");
            this.#db.exec("PRAGMA synchronous = FULL");
            this.#db.exec("PRAGMA foreign_keys = ON");
            this.#db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs)}`);
            this.#db.exec("PRAGMA mmap_size = 0");
            migrate(this.#db);
        } catch (error) {
            this.#db.close();
            throw error;
        }
        this.#tx = this.#createWriteTransaction();
    }

    /** 데이터베이스 파일의 경로입니다. */
    get path(): string {
        return this.#path;
    }

    /** 쓰기 연결의 SQLite 설정입니다. 설정을 확인할 때 씁니다. */
    settings(): {
        readonly journalMode: string;
        readonly synchronous: number;
        readonly foreignKeys: number;
        readonly busyTimeoutMs: number;
        readonly mmapSize: number;
    } {
        // PRAGMA마다 결과 열의 이름이 달라(busy_timeout은 timeout) 첫 값을 읽습니다.
        const pragma = <T>(name: string) => this.#db.query(`PRAGMA ${name}`).values()[0]?.[0] as T;
        return {
            journalMode: pragma<string>("journal_mode"),
            synchronous: pragma<number>("synchronous"),
            foreignKeys: pragma<number>("foreign_keys"),
            busyTimeoutMs: pragma<number>("busy_timeout"),
            mmapSize: pragma<number>("mmap_size"),
        };
    }

    write<T>(work: (tx: WriteTransaction) => T): T {
        return this.#db.transaction(() => work(this.#tx)).immediate();
    }

    derivationVersion(): number | undefined {
        return this.#db.query<{ version: number }, []>(SQL.derivationVersion).get()?.version;
    }

    listTurnKeys(after: TurnKey | undefined, limit: number): readonly TurnKey[] {
        return this.#db
            .query<{ agent_pk: number; turn_id: string }, Record<string, string | number>>(
                SQL.turnKeys,
            )
            .all({ agent_pk: after?.agentPk ?? 0, turn_id: after?.turnId ?? "", limit })
            .map((row) => ({ agentPk: row.agent_pk, turnId: row.turn_id }));
    }

    listSessions(filter: SessionFilter): readonly StoredSession[] {
        return this.#db
            .query<SessionRow, Record<string, string | number | null>>(SQL.listSessions)
            .all({
                agent_kind: filter.agentKind ?? null,
                cwd: filter.cwd ?? null,
                host: filter.host ?? null,
                limit: filter.limit,
                offset: filter.offset,
            })
            .map(toStoredSession);
    }

    findSession(ref: SessionRef): StoredSession | undefined {
        const row = this.#db
            .query<SessionRow, Record<string, string>>(SQL.findSession)
            .get({ agent_kind: ref.agentKind, session_id: ref.sessionId });
        return row === null ? undefined : toStoredSession(row);
    }

    findAgent(sessionPk: number, agentId: string): AgentRecord | undefined {
        const row = this.#db
            .query<{ pk: number; parent_agent_id: string | null }, Record<string, string | number>>(
                SQL.findAgent,
            )
            .get({ session_pk: sessionPk, agent_id: agentId });
        if (row === null) return undefined;
        return { pk: row.pk, ...present({ parentId: row.parent_agent_id }) };
    }

    listAgents(sessionPk: number): readonly StoredAgent[] {
        return this.#db
            .query<
                { pk: number; agent_id: string; parent_agent_id: string | null; usage: string },
                Record<string, number>
            >(SQL.listAgents)
            .all({ session_pk: sessionPk })
            .map((row) => ({
                pk: row.pk,
                agentId: row.agent_id,
                usage: usageFromSum(row.usage),
                ...present({ parentId: row.parent_agent_id }),
            }));
    }

    listTurnTimes(sessionPk: number): readonly StoredTurnTime[] {
        return this.#db
            .query<
                {
                    agent_pk: number;
                    turn_id: string;
                    started_at_us: number;
                    ended_at_us: number;
                    ingest_id: number;
                },
                Record<string, number>
            >(SQL.listTurnTimes)
            .all({ session_pk: sessionPk })
            .map((row) => ({
                agentPk: row.agent_pk,
                turnId: row.turn_id,
                startedAtUs: row.started_at_us,
                endedAtUs: row.ended_at_us,
                ingestId: row.ingest_id,
            }));
    }

    listTurns(agentPk: number, previewLength: number): readonly StoredTurn[] {
        return this.#db
            .query<TurnRow, Record<string, number>>(READ_SQL.listTurns)
            .all({ agent_pk: agentPk, preview_length: previewLength })
            .map(toStoredTurn);
    }

    findTurn(key: TurnKey, previewLength: number): StoredTurn | undefined {
        const row = this.#db
            .query<TurnRow, Record<string, string | number>>(READ_SQL.findTurn)
            .get({ agent_pk: key.agentPk, turn_id: key.turnId, preview_length: previewLength });
        return row === null ? undefined : toStoredTurn(row);
    }

    listLlmCalls(key: TurnKey): readonly StoredLlmCall[] {
        return this.#db
            .query<LlmCallRow, Record<string, string | number>>(READ_SQL.listLlmCalls)
            .all({ agent_pk: key.agentPk, turn_id: key.turnId })
            .map(toStoredLlmCall);
    }

    listToolCalls(key: TurnKey): readonly ToolCall[] {
        return this.#db
            .query<ToolCallRow, Record<string, string | number>>(READ_SQL.listToolCalls)
            .all({ agent_pk: key.agentPk, turn_id: key.turnId })
            .map(toToolCall);
    }

    listCompactions(key: TurnKey): readonly Compaction[] {
        return this.#db
            .query<CompactionRow, Record<string, string | number>>(SQL.listCompactions)
            .all({ agent_pk: key.agentPk, turn_id: key.turnId })
            .map(toCompaction);
    }

    listTurnEventSlots(key: TurnKey): readonly StoredEventSlot[] {
        return this.#db
            .query<
                { position: number; type: string; event_id: string; timestamp_us: number },
                Record<string, string | number>
            >(READ_SQL.listTurnEventSlots)
            .all({ agent_pk: key.agentPk, turn_id: key.turnId })
            .map((row) => ({
                position: row.position,
                type: row.type,
                eventId: row.event_id,
                timestampUs: row.timestamp_us,
            }));
    }

    listToolCallInputPreviews(
        key: TurnKey,
        previewLength: number,
    ): readonly StoredToolCallInputPreview[] {
        return this.#db
            .query<
                {
                    llm_call_id: string;
                    ordinal: number;
                    input_preview: string | null;
                    input_length: number | null;
                },
                Record<string, string | number>
            >(READ_SQL.listToolCallInputPreviews)
            .all({ agent_pk: key.agentPk, turn_id: key.turnId, preview_length: previewLength })
            .map((row) => ({
                llmCallId: row.llm_call_id,
                ordinal: row.ordinal,
                inputPreview: row.input_preview ?? "",
                inputLength: row.input_length ?? 0,
            }));
    }

    listToolCallResultLengths(
        sessionPk: number,
        key: TurnKey,
    ): readonly StoredToolCallResultLength[] {
        return this.#db
            .query<
                { llm_call_id: string; ordinal: number; result_length: number | null },
                Record<string, string | number>
            >(READ_SQL.listToolCallResultLengths)
            .all({ session_pk: sessionPk, agent_pk: key.agentPk, turn_id: key.turnId })
            .flatMap((row) =>
                row.result_length === null
                    ? []
                    : [
                          {
                              llmCallId: row.llm_call_id,
                              ordinal: row.ordinal,
                              resultLength: row.result_length,
                          },
                      ],
            );
    }

    listSessionLlmCalls(sessionPk: number, filter: StoredLlmCallFilter): readonly StoredLlmCall[] {
        return this.#db
            .query<LlmCallRow, Record<string, string | number | null>>(READ_SQL.listSessionLlmCalls)
            .all({
                session_pk: sessionPk,
                agent_pk: filter.agentPk ?? null,
                failed: booleanParam(filter.failed),
                stop_reason: filter.stopReason ?? null,
            })
            .map(toStoredLlmCall);
    }

    findLlmCall(
        agentPk: number,
        llmCallId: string,
    ): { readonly turnId: string; readonly position: number } | undefined {
        const row = this.#db
            .query<{ turn_id: string; position: number }, Record<string, string | number>>(
                SQL.findLlmCall,
            )
            .get({ agent_pk: agentPk, llm_call_id: llmCallId });
        return row === null ? undefined : { turnId: row.turn_id, position: row.position };
    }

    findToolCall(agentPk: number, llmCallId: string, ordinal: number): ToolCall | undefined {
        const row = this.#db
            .query<ToolCallRow, Record<string, string | number>>(READ_SQL.findToolCall)
            .get({ agent_pk: agentPk, llm_call_id: llmCallId, ordinal });
        return row === null ? undefined : toToolCall(row);
    }

    listTurnOrderKeys(agentPk: number): readonly TurnOrderKey[] {
        return this.#db
            .query<
                { turn_id: string; started_at_us: number; ingest_id: number },
                Record<string, number>
            >(SQL.listTurnOrderKeys)
            .all({ agent_pk: agentPk })
            .map((row) => ({
                turnId: row.turn_id,
                startedAtUs: row.started_at_us,
                ingestId: row.ingest_id,
            }));
    }

    listCompactionPositions(
        agentPk: number,
    ): readonly { readonly turnId: string; readonly position: number }[] {
        return this.#db
            .query<{ turn_id: string; position: number }, Record<string, number>>(
                SQL.listCompactionPositions,
            )
            .all({ agent_pk: agentPk })
            .map((row) => ({ turnId: row.turn_id, position: row.position }));
    }

    getEventBody(sessionPk: number, eventId: string): string | undefined {
        return (
            this.#db
                .query<{ body: string }, Record<string, string | number>>(SQL.getEventBody)
                .get({ session_pk: sessionPk, event_id: eventId })?.body ?? undefined
        );
    }

    /**
     * 읽기 전용 연결을 따로 열어 한 번의 스냅숏으로 읽습니다. 같은 연결에서 읽기를 오래 열어 두면 그 연결의 다른
     * 질의도 같은 스냅숏을 보게 되고, 캐시된 질의를 함께 쓰면 서로의 진행을 되돌리기 때문입니다.
     * 본문은 한 행씩 읽으며, 인덱스 순서로 읽으므로 정렬하려고 본문을 모으지 않습니다.
     */
    *iterateEvents(
        agentPk: number,
        segments: readonly EventSegment[],
        types: readonly string[],
    ): Generator<InputEvent, void, undefined> {
        const db = new Database(this.#path, { readonly: true, strict: true });
        let statement: Statement<EventRow, [Record<string, string | number>]> | undefined;
        try {
            db.exec(`PRAGMA busy_timeout = ${Math.trunc(this.#busyTimeoutMs)}`);
            db.exec("PRAGMA mmap_size = 0");
            db.exec("BEGIN");
            statement = db.prepare<EventRow, [Record<string, string | number>]>(SQL.segmentEvents);
            const typeList = JSON.stringify(types);
            for (const segment of segments) {
                const rows = statement.iterate({
                    agent_pk: agentPk,
                    turn_id: segment.turnId,
                    from_position: segment.fromPosition,
                    to_position: segment.toPosition ?? Number.MAX_SAFE_INTEGER,
                    types: typeList,
                });
                for (const row of rows) {
                    yield {
                        eventId: row.event_id,
                        turnId: row.turn_id,
                        position: row.position,
                        type: row.type,
                        timestampUs: row.timestamp_us,
                        body: row.body,
                    };
                }
            }
            db.exec("COMMIT");
        } finally {
            statement?.finalize();
            db.close();
        }
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#db.close();
    }

    #createWriteTransaction(): WriteTransaction {
        const db = this.#db;
        const run = (sql: string, params: Record<string, string | number | null>) =>
            db.query<unknown, Record<string, string | number | null>>(sql).run(params);

        return {
            ensureSession(agentKind: string, sessionId: string): SessionRecord {
                const params = { agent_kind: agentKind, session_id: sessionId };
                run(SQL.insertSession, params);
                const row = db
                    .query<
                        { pk: number; cwd: string | null; host: string | null },
                        Record<string, string>
                    >(SQL.selectSessionRecord)
                    .get(params);
                if (row === null) throw new Error("session was not stored");
                return { pk: row.pk, ...present({ cwd: row.cwd, host: row.host }) };
            },
            fillSession(sessionPk, fields) {
                if (fields.cwd !== undefined) {
                    run(SQL.fillSessionCwd, { pk: sessionPk, value: fields.cwd });
                }
                if (fields.host !== undefined) {
                    run(SQL.fillSessionHost, { pk: sessionPk, value: fields.host });
                }
            },
            ensureAgent(sessionPk: number, agentId: string): AgentRecord {
                const params = { session_pk: sessionPk, agent_id: agentId };
                run(SQL.insertAgent, params);
                const row = db
                    .query<
                        { pk: number; parent_agent_id: string | null },
                        Record<string, string | number>
                    >(SQL.selectAgentRecord)
                    .get(params);
                if (row === null) throw new Error("agent was not stored");
                return { pk: row.pk, ...present({ parentId: row.parent_agent_id }) };
            },
            fillAgentParent(agentPk, parentId) {
                run(SQL.fillAgentParent, { pk: agentPk, parent_agent_id: parentId });
            },
            addIngest(record: IngestRecord): number {
                const result = run(SQL.insertIngest, {
                    transport_unit_id: record.transportUnitId,
                    protocol_version: record.protocolVersion,
                    plugin_version: record.pluginVersion,
                    session_pk: record.sessionPk,
                    agent_pk: record.agentPk,
                    received_at_us: record.receivedAtUs,
                    event_count: record.eventCount,
                    dropped_count: record.droppedCount,
                });
                return Number(result.lastInsertRowid);
            },
            setIngestStoredCount(ingestId, storedCount) {
                run(SQL.setIngestStoredCount, { id: ingestId, stored_count: storedCount });
            },
            addEvent(record: EventRecord): boolean {
                const result = run(SQL.insertEvent, {
                    session_pk: record.sessionPk,
                    event_id: record.eventId,
                    agent_pk: record.agentPk,
                    turn_id: record.turnId,
                    position: record.position,
                    type: record.type,
                    timestamp_us: record.timestampUs,
                    body: record.body,
                    ingest_id: record.ingestId,
                });
                return result.changes > 0;
            },
            *iterateTurnEvents(key: TurnKey): Generator<TurnEventRow, void, undefined> {
                const rows = db
                    .query<
                        {
                            event_id: string;
                            position: number;
                            type: string;
                            timestamp_us: number;
                            ingest_id: number;
                            body: string;
                        },
                        Record<string, string | number>
                    >(SQL.turnEvents)
                    .iterate({ agent_pk: key.agentPk, turn_id: key.turnId });
                for (const row of rows) {
                    yield {
                        eventId: row.event_id,
                        position: row.position,
                        type: row.type,
                        timestampUs: row.timestamp_us,
                        ingestId: row.ingest_id,
                        body: row.body,
                    };
                }
            },
            hasOtherTurnEventReceivedAfter(key, ingestId) {
                const row = db
                    .query<{ later: number }, Record<string, string | number>>(
                        SQL.hasOtherTurnEventReceivedAfter,
                    )
                    .get({ agent_pk: key.agentPk, turn_id: key.turnId, ingest_id: ingestId });
                return row?.later === 1;
            },
            replaceTurn(key, turn) {
                const where = { agent_pk: key.agentPk, turn_id: key.turnId };
                run(SQL.deleteTurnToolCalls, where);
                run(SQL.deleteTurnLlmCalls, where);
                run(SQL.deleteTurnCompactions, where);
                run(SQL.deleteTurn, where);
                if (turn !== undefined) insertTurn(key, turn);
            },
            markInProgressTurnsErrored(agentPk, exceptTurnId) {
                run(SQL.markInProgressTurnsErrored, { agent_pk: agentPk, turn_id: exceptTurnId });
            },
            clearDerived() {
                db.exec(SQL.clearDerived);
            },
            setDerivationVersion(version) {
                run(SQL.setDerivationVersion, { version });
            },
        };

        function insertTurn(key: TurnKey, turn: DerivedTurn): void {
            const owner = { agent_pk: key.agentPk, turn_id: key.turnId };
            run(SQL.insertTurn, {
                ...owner,
                status: turn.status,
                started_at_us: turn.startedAtUs,
                ended_at_us: turn.endedAtUs,
                ingest_id: turn.ingestId,
            });
            for (const call of turn.llmCalls) {
                run(SQL.insertLlmCall, {
                    ...owner,
                    llm_call_id: call.id,
                    position: call.position,
                    model: call.model ?? null,
                    stop_reason: call.stopReason ?? null,
                    failed: call.failed ? 1 : 0,
                    attempt: call.attempt ?? null,
                    started_at_us: call.startedAtUs,
                    started_at_estimated: call.startedAtEstimated ? 1 : 0,
                    ended_at_us: call.endedAtUs,
                    ...tokenParams(call.usage),
                });
            }
            for (const call of turn.toolCalls) {
                run(SQL.insertToolCall, {
                    agent_pk: key.agentPk,
                    llm_call_id: call.llmCallId,
                    ordinal: call.ordinal,
                    tool_use_id: call.toolUseId,
                    name: call.name,
                    result_event_id: call.resultEventId ?? null,
                    is_error: booleanParam(call.isError),
                    started_at_us: call.startedAtUs,
                    ended_at_us: call.endedAtUs ?? null,
                    subagent_id: call.subagentId ?? null,
                });
            }
            for (const compaction of turn.compactions) {
                run(SQL.insertCompaction, {
                    ...owner,
                    compaction_id: compaction.id,
                    position: compaction.position,
                    summary_event_id: compaction.summaryEventId ?? null,
                    trigger: compaction.trigger ?? null,
                    context_tokens_before: compaction.contextTokensBefore ?? null,
                    model: compaction.model ?? null,
                    started_at_us: compaction.startedAtUs,
                    ended_at_us: compaction.endedAtUs ?? null,
                    ...tokenParams(compaction.usage),
                });
            }
        }
    }
}

function checkSqliteVersion(db: Database): void {
    const version = db.query<{ v: string }, []>("SELECT sqlite_version() AS v").get()?.v ?? "0";
    const parts = version.split(".").map(Number);
    for (let index = 0; index < MIN_SQLITE_VERSION.length; index += 1) {
        const actual = parts[index] ?? 0;
        const required = MIN_SQLITE_VERSION[index] ?? 0;
        if (actual > required) return;
        if (actual < required) {
            throw new Error(
                `SQLite ${MIN_SQLITE_VERSION.join(".")} or later is required, found ${version}`,
            );
        }
    }
}

/** 스키마를 최신 버전으로 올립니다. 버전마다 트랜잭션 하나로 올립니다. */
function migrate(db: Database): void {
    const version =
        db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version > MIGRATIONS.length) {
        throw new UnsupportedSchemaError(
            `database schema version ${version} is newer than the supported version ${MIGRATIONS.length}`,
        );
    }
    for (let next = version; next < MIGRATIONS.length; next += 1) {
        const sql = MIGRATIONS[next] ?? "";
        db.transaction(() => {
            db.exec(sql);
            db.exec(`PRAGMA user_version = ${next + 1}`);
        }).immediate();
    }
}
