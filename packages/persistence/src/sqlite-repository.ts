import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import type {
  AgentRecord,
  AgentSummary,
  CompactionView,
  DerivedTurn,
  EventCursor,
  EventRecord,
  IngestRecord,
  LlmCallView,
  Repository,
  SessionFilter,
  SessionRecord,
  SessionSummary,
  StopReason,
  TokenUsage,
  ToolCallView,
  TurnEventRow,
  TurnKey,
  TurnStatus,
  TurnSummary,
} from "@alm/core";
import { MIGRATIONS } from "./schema";

export interface SqliteOptions {
  /** SQLite 데이터베이스 파일의 경로입니다. */
  readonly path: string;
  /** 쓰기 잠금을 기다리는 최대 시간(밀리초)입니다. Daemon의 Ack 타임아웃보다 짧아야 합니다. */
  readonly busyTimeoutMs: number;
}

interface TokenColumns {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
}

const TOKEN_COLUMNS = `input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens`;

const PROMPT_PREVIEW_CHARS = 300;

/** 한 번의 트랜잭션이나 Session 단위로 묶어 더하는 토큰 합계 CTE입니다. */
const USAGE_SUM = `
  SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
  SUM(reasoning_tokens) AS reasoning_tokens`;

const AGENT_USAGE = `
  SELECT agent_pk, ${USAGE_SUM} FROM (
    SELECT agent_pk, ${TOKEN_COLUMNS} FROM llm_call
    UNION ALL
    SELECT agent_pk, ${TOKEN_COLUMNS} FROM compaction
  ) GROUP BY agent_pk`;

const SESSION_SUMMARY_SELECT = `
  SELECT s.agent_kind, s.session_id, s.cwd, s.host,
    (SELECT COUNT(*) FROM agent a WHERE a.session_pk = s.pk) AS agent_count,
    (SELECT COUNT(*) FROM turn t JOIN agent a ON a.pk = t.agent_pk WHERE a.session_pk = s.pk) AS turn_count,
    (SELECT COUNT(*) FROM turn t JOIN agent a ON a.pk = t.agent_pk
      WHERE a.session_pk = s.pk AND t.status <> 'completed') AS unfinished_turn_count,
    (SELECT MIN(t.started_at_us) FROM turn t JOIN agent a ON a.pk = t.agent_pk
      WHERE a.session_pk = s.pk) AS started_at_us,
    (SELECT MAX(t.ended_at_us) FROM turn t JOIN agent a ON a.pk = t.agent_pk
      WHERE a.session_pk = s.pk) AS ended_at_us,
    (SELECT substr(json_extract(e.body, '$.text'), 1, ${PROMPT_PREVIEW_CHARS})
       FROM turn t
       JOIN agent a ON a.pk = t.agent_pk AND a.parent_agent_id IS NULL
       JOIN event e ON e.agent_pk = t.agent_pk AND e.turn_id = t.turn_id AND e.position = 0
      WHERE a.session_pk = s.pk
      ORDER BY t.started_at_us, t.ingest_id LIMIT 1) AS first_prompt,
    u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.reasoning_tokens
  FROM session s
  LEFT JOIN (
    SELECT a.session_pk, ${USAGE_SUM}
    FROM agent a JOIN (${AGENT_USAGE}) au ON au.agent_pk = a.pk
    GROUP BY a.session_pk
  ) u ON u.session_pk = s.pk`;

interface SessionSummaryRow extends TokenColumns {
  agent_kind: string;
  session_id: string;
  cwd: string | null;
  host: string | null;
  agent_count: number;
  turn_count: number;
  unfinished_turn_count: number;
  started_at_us: number | null;
  ended_at_us: number | null;
  first_prompt: string | null;
}

interface TurnSummaryRow extends TokenColumns {
  turn_id: string;
  status: TurnStatus;
  started_at_us: number;
  ended_at_us: number;
  prompt: string | null;
  prompt_chars: number | null;
  loop_count: number;
  tool_call_count: number;
  failed_count: number;
  compaction_count: number;
}

const TURN_SUMMARY_SELECT = `
  SELECT t.turn_id, t.status, t.started_at_us, t.ended_at_us,
    substr(json_extract(e.body, '$.text'), 1, ${PROMPT_PREVIEW_CHARS}) AS prompt,
    length(json_extract(e.body, '$.text')) AS prompt_chars,
    (SELECT COUNT(*) FROM llm_call c WHERE c.agent_pk = t.agent_pk AND c.turn_id = t.turn_id) AS loop_count,
    (SELECT COUNT(*) FROM llm_call c WHERE c.agent_pk = t.agent_pk AND c.turn_id = t.turn_id AND c.failed = 1) AS failed_count,
    (SELECT COUNT(*) FROM tool_call tc JOIN llm_call c
       ON c.agent_pk = tc.agent_pk AND c.llm_call_id = tc.llm_call_id
      WHERE c.agent_pk = t.agent_pk AND c.turn_id = t.turn_id) AS tool_call_count,
    (SELECT COUNT(*) FROM compaction m WHERE m.agent_pk = t.agent_pk AND m.turn_id = t.turn_id) AS compaction_count,
    u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.reasoning_tokens
  FROM turn t
  JOIN event e ON e.agent_pk = t.agent_pk AND e.turn_id = t.turn_id AND e.position = 0
  LEFT JOIN (
    SELECT turn_id, ${USAGE_SUM} FROM (
      SELECT turn_id, ${TOKEN_COLUMNS} FROM llm_call WHERE agent_pk = :agent_pk
      UNION ALL
      SELECT turn_id, ${TOKEN_COLUMNS} FROM compaction WHERE agent_pk = :agent_pk
    ) GROUP BY turn_id
  ) u ON u.turn_id = t.turn_id`;

function toUsage(row: TokenColumns): TokenUsage {
  return {
    ...(row.input_tokens === null ? {} : { input_tokens: row.input_tokens }),
    ...(row.output_tokens === null ? {} : { output_tokens: row.output_tokens }),
    ...(row.cache_read_tokens === null ? {} : { cache_read_tokens: row.cache_read_tokens }),
    ...(row.cache_write_tokens === null ? {} : { cache_write_tokens: row.cache_write_tokens }),
    ...(row.reasoning_tokens === null ? {} : { reasoning_tokens: row.reasoning_tokens }),
  };
}

function tokenValues(usage: TokenUsage | undefined): (number | null)[] {
  return [
    usage?.input_tokens ?? null,
    usage?.output_tokens ?? null,
    usage?.cache_read_tokens ?? null,
    usage?.cache_write_tokens ?? null,
    usage?.reasoning_tokens ?? null,
  ];
}

function toSessionSummary(row: SessionSummaryRow): SessionSummary {
  return {
    agent: row.agent_kind,
    id: row.session_id,
    agentCount: row.agent_count,
    turnCount: row.turn_count,
    unfinishedTurnCount: row.unfinished_turn_count,
    usage: toUsage(row),
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
    ...(row.host === null ? {} : { host: row.host }),
    ...(row.first_prompt === null ? {} : { firstPrompt: row.first_prompt }),
    ...(row.started_at_us === null ? {} : { startedAtUs: row.started_at_us }),
    ...(row.ended_at_us === null ? {} : { endedAtUs: row.ended_at_us }),
  };
}

function toTurnSummary(row: TurnSummaryRow): TurnSummary {
  return {
    id: row.turn_id,
    prompt: row.prompt ?? "",
    promptTruncated: (row.prompt_chars ?? 0) > PROMPT_PREVIEW_CHARS,
    status: row.status,
    startedAtUs: row.started_at_us,
    endedAtUs: row.ended_at_us,
    loopCount: row.loop_count,
    toolCallCount: row.tool_call_count,
    failedLlmCallCount: row.failed_count,
    compactionCount: row.compaction_count,
    usage: toUsage(row),
  };
}

/** Core의 Repository API를 SQLite로 구현합니다. docs/002.implementation/008.DATA_STORAGE.md를 따릅니다. */
export class SqliteRepository implements Repository {
  readonly #write: Database;
  /** 본문을 스트리밍으로 읽는 동안 쓰기 트랜잭션과 섞이지 않도록 읽기 연결을 따로 둡니다. */
  readonly #read: Database;

  constructor(options: SqliteOptions) {
    this.#write = new Database(options.path, { create: true, strict: false });
    this.#configure(this.#write, options.busyTimeoutMs);
    this.#migrate();
    this.#read = new Database(options.path, { readonly: true });
    this.#read.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`);
    this.#read.exec("PRAGMA mmap_size = 0");
  }

  close(): void {
    this.#read.close();
    this.#write.close();
  }

  #configure(db: Database, busyTimeoutMs: number): void {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    db.exec("PRAGMA mmap_size = 0");
  }

  #migrate(): void {
    const row = this.#write.query("PRAGMA user_version").get() as { user_version: number };
    for (let version = row.user_version; version < MIGRATIONS.length; version += 1) {
      this.#write.transaction(() => {
        this.#write.exec(MIGRATIONS[version] as string);
        this.#write.exec(`PRAGMA user_version = ${version + 1}`);
      })();
    }
  }

  #w(sql: string): Statement {
    return this.#write.query(sql);
  }

  #r(sql: string): Statement {
    return this.#read.query(sql);
  }

  transaction<T>(work: () => T): T {
    return this.#write.transaction(work).immediate();
  }

  findOrCreateSession(agentKind: string, sessionId: string): SessionRecord {
    this.#w(
      `INSERT INTO session (agent_kind, session_id) VALUES (?, ?)
       ON CONFLICT (agent_kind, session_id) DO NOTHING`,
    ).run(agentKind, sessionId);
    const row = this.#w(
      "SELECT pk, cwd, host FROM session WHERE agent_kind = ? AND session_id = ?",
    ).get(agentKind, sessionId) as { pk: number; cwd: string | null; host: string | null };
    return {
      pk: row.pk,
      ...(row.cwd === null ? {} : { cwd: row.cwd }),
      ...(row.host === null ? {} : { host: row.host }),
    };
  }

  fillSession(pk: number, fields: { cwd?: string; host?: string }): void {
    if (fields.cwd !== undefined) {
      this.#w("UPDATE session SET cwd = ? WHERE pk = ? AND cwd IS NULL").run(fields.cwd, pk);
    }
    if (fields.host !== undefined) {
      this.#w("UPDATE session SET host = ? WHERE pk = ? AND host IS NULL").run(fields.host, pk);
    }
  }

  findOrCreateAgent(sessionPk: number, agentId: string): AgentRecord {
    this.#w(
      `INSERT INTO agent (session_pk, agent_id) VALUES (?, ?)
       ON CONFLICT (session_pk, agent_id) DO NOTHING`,
    ).run(sessionPk, agentId);
    const row = this.#w(
      "SELECT pk, parent_agent_id FROM agent WHERE session_pk = ? AND agent_id = ?",
    ).get(sessionPk, agentId) as { pk: number; parent_agent_id: string | null };
    return {
      pk: row.pk,
      ...(row.parent_agent_id === null ? {} : { parentId: row.parent_agent_id }),
    };
  }

  fillAgent(pk: number, parentId: string): void {
    this.#w("UPDATE agent SET parent_agent_id = ? WHERE pk = ? AND parent_agent_id IS NULL").run(
      parentId,
      pk,
    );
  }

  insertIngest(record: IngestRecord): number {
    const row = this.#w(
      `INSERT INTO ingest (transport_unit_id, protocol_version, plugin_version, session_pk,
         agent_pk, received_at_us, event_count, stored_count, dropped_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?) RETURNING id`,
    ).get(
      record.transportUnitId,
      record.protocolVersion,
      record.pluginVersion,
      record.sessionPk,
      record.agentPk,
      record.receivedAtUs,
      record.eventCount,
      record.droppedCount,
    ) as { id: number };
    return row.id;
  }

  setIngestStoredCount(id: number, storedCount: number): void {
    this.#w("UPDATE ingest SET stored_count = ? WHERE id = ?").run(storedCount, id);
  }

  insertEvent(record: EventRecord): boolean {
    const result = this.#w(
      `INSERT INTO event (session_pk, event_id, agent_pk, turn_id, position, type, timestamp_us,
         body, ingest_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_pk, event_id) DO NOTHING`,
    ).run(
      record.sessionPk,
      record.eventId,
      record.agentPk,
      record.turnId,
      record.position,
      record.type,
      record.timestampUs,
      JSON.stringify(record.body),
      record.ingestId,
    );
    return result.changes > 0;
  }

  *iterateTurnEvents(key: TurnKey): Iterable<TurnEventRow> {
    const rows = this.#w(
      `SELECT event_id, position, type, timestamp_us, ingest_id, body FROM event
       WHERE agent_pk = ? AND turn_id = ? ORDER BY position`,
    ).iterate(key.agentPk, key.turnId) as IterableIterator<{
      event_id: string;
      position: number;
      type: string;
      timestamp_us: number;
      ingest_id: number;
      body: string;
    }>;
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
  }

  hasLaterEventInOtherTurn(key: TurnKey, afterIngestId: number): boolean {
    const row = this.#w(
      `SELECT 1 FROM event
       WHERE ingest_id > ? AND agent_pk = ? AND turn_id <> ? LIMIT 1`,
    ).get(afterIngestId, key.agentPk, key.turnId);
    return row !== null;
  }

  replaceTurn(key: TurnKey, turn: DerivedTurn | undefined): void {
    const keyValues = [key.agentPk, key.turnId] as const;
    this.#w(
      `DELETE FROM tool_call WHERE agent_pk = ?1 AND llm_call_id IN
         (SELECT llm_call_id FROM llm_call WHERE agent_pk = ?1 AND turn_id = ?2)`,
    ).run(...keyValues);
    this.#w("DELETE FROM llm_call WHERE agent_pk = ? AND turn_id = ?").run(...keyValues);
    this.#w("DELETE FROM compaction WHERE agent_pk = ? AND turn_id = ?").run(...keyValues);
    this.#w("DELETE FROM turn WHERE agent_pk = ? AND turn_id = ?").run(...keyValues);
    if (!turn) return;

    this.#w(
      `INSERT INTO turn (agent_pk, turn_id, status, started_at_us, ended_at_us, ingest_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(...keyValues, turn.status, turn.startedAtUs, turn.endedAtUs, turn.ingestId);

    for (const call of turn.llmCalls) {
      this.#w(
        `INSERT INTO llm_call (agent_pk, llm_call_id, turn_id, position, model, stop_reason, failed,
           attempt, started_at_us, started_at_estimated, ended_at_us, ${TOKEN_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        key.agentPk,
        call.id,
        key.turnId,
        call.position,
        call.model ?? null,
        call.stopReason ?? null,
        call.failed ? 1 : 0,
        call.attempt ?? null,
        call.startedAtUs,
        call.startedAtEstimated ? 1 : 0,
        call.endedAtUs,
        ...tokenValues(call.usage),
      );
    }

    for (const call of turn.toolCalls) {
      this.#w(
        `INSERT INTO tool_call (agent_pk, llm_call_id, ordinal, tool_use_id, name, result_event_id,
           is_error, started_at_us, ended_at_us, subagent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        key.agentPk,
        call.llmCallId,
        call.ordinal,
        call.toolUseId,
        call.name,
        call.resultEventId ?? null,
        call.isError === undefined ? null : call.isError ? 1 : 0,
        call.startedAtUs,
        call.endedAtUs ?? null,
        call.subagentId ?? null,
      );
    }

    for (const compaction of turn.compactions) {
      this.#w(
        `INSERT INTO compaction (agent_pk, compaction_id, turn_id, position, summary_event_id,
           trigger, context_tokens_before, model, started_at_us, ended_at_us, ${TOKEN_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        key.agentPk,
        compaction.id,
        key.turnId,
        compaction.position,
        compaction.summaryEventId ?? null,
        compaction.trigger ?? null,
        compaction.contextTokensBefore ?? null,
        compaction.model ?? null,
        compaction.startedAtUs,
        compaction.endedAtUs ?? null,
        ...tokenValues(compaction.usage),
      );
    }
  }

  markOtherInProgressTurnsErrored(key: TurnKey): void {
    this.#w(
      `UPDATE turn SET status = 'errored'
       WHERE agent_pk = ? AND status = 'in_progress' AND turn_id <> ?`,
    ).run(key.agentPk, key.turnId);
  }

  derivationVersion(): number | undefined {
    const row = this.#write.query("SELECT version FROM derivation WHERE id = 1").get() as {
      version: number;
    } | null;
    return row?.version;
  }

  clearDerived(version: number): void {
    this.#write.exec(
      "DELETE FROM tool_call; DELETE FROM llm_call; DELETE FROM compaction; DELETE FROM turn",
    );
    this.#w(
      `INSERT INTO derivation (id, version) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET version = excluded.version`,
    ).run(version);
  }

  *iterateTurnKeys(): Iterable<TurnKey> {
    const rows = this.#w(
      "SELECT DISTINCT agent_pk, turn_id FROM event ORDER BY agent_pk, turn_id",
    ).iterate() as IterableIterator<{ agent_pk: number; turn_id: string }>;
    for (const row of rows) yield { agentPk: row.agent_pk, turnId: row.turn_id };
  }

  listSessions(filter: SessionFilter): readonly SessionSummary[] {
    const conditions: string[] = [];
    const values: SQLQueryBindings[] = [];
    for (const [column, value] of [
      ["s.agent_kind", filter.agent],
      ["s.cwd", filter.cwd],
      ["s.host", filter.host],
    ] as const) {
      if (value === undefined) continue;
      conditions.push(`${column} = ?`);
      values.push(value);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.#r(
      `${SESSION_SUMMARY_SELECT} ${where}
       ORDER BY started_at_us DESC NULLS LAST, s.pk DESC LIMIT ? OFFSET ?`,
    ).all(...values, filter.limit, filter.offset) as SessionSummaryRow[];
    return rows.map(toSessionSummary);
  }

  findSessionSummary(agentKind: string, sessionId: string): SessionSummary | undefined {
    const row = this.#r(
      `${SESSION_SUMMARY_SELECT} WHERE s.agent_kind = ? AND s.session_id = ?`,
    ).get(agentKind, sessionId) as SessionSummaryRow | null;
    return row ? toSessionSummary(row) : undefined;
  }

  listAgents(agentKind: string, sessionId: string): readonly AgentSummary[] {
    const rows = this.#r(
      `SELECT a.pk, a.agent_id, a.parent_agent_id,
         (SELECT COUNT(*) FROM turn t WHERE t.agent_pk = a.pk) AS turn_count,
         (SELECT MIN(t.started_at_us) FROM turn t WHERE t.agent_pk = a.pk) AS started_at_us,
         (SELECT MAX(t.ended_at_us) FROM turn t WHERE t.agent_pk = a.pk) AS ended_at_us,
         u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
         u.reasoning_tokens
       FROM agent a
       JOIN session s ON s.pk = a.session_pk
       LEFT JOIN (${AGENT_USAGE}) u ON u.agent_pk = a.pk
       WHERE s.agent_kind = ? AND s.session_id = ?
       ORDER BY started_at_us NULLS LAST, a.pk`,
    ).all(agentKind, sessionId) as (TokenColumns & {
      pk: number;
      agent_id: string;
      parent_agent_id: string | null;
      turn_count: number;
      started_at_us: number | null;
      ended_at_us: number | null;
    })[];
    return rows.map((row) => ({
      pk: row.pk,
      id: row.agent_id,
      turnCount: row.turn_count,
      usage: toUsage(row),
      ...(row.parent_agent_id === null ? {} : { parentId: row.parent_agent_id }),
      ...(row.started_at_us === null ? {} : { startedAtUs: row.started_at_us }),
      ...(row.ended_at_us === null ? {} : { endedAtUs: row.ended_at_us }),
    }));
  }

  listTurns(agentPk: number): readonly TurnSummary[] {
    const rows = this.#r(
      `${TURN_SUMMARY_SELECT} WHERE t.agent_pk = :agent_pk ORDER BY t.started_at_us, t.ingest_id`,
    ).all({ ":agent_pk": agentPk }) as TurnSummaryRow[];
    return rows.map(toTurnSummary);
  }

  findTurn(key: TurnKey): TurnSummary | undefined {
    const row = this.#r(
      `${TURN_SUMMARY_SELECT} WHERE t.agent_pk = :agent_pk AND t.turn_id = :turn_id`,
    ).get({ ":agent_pk": key.agentPk, ":turn_id": key.turnId }) as TurnSummaryRow | null;
    return row ? toTurnSummary(row) : undefined;
  }

  listLlmCalls(key: TurnKey): readonly LlmCallView[] {
    const rows = this.#r(
      `SELECT llm_call_id, position, model, stop_reason, failed, attempt, started_at_us,
         started_at_estimated, ended_at_us, ${TOKEN_COLUMNS}
       FROM llm_call WHERE agent_pk = ? AND turn_id = ? ORDER BY position`,
    ).all(key.agentPk, key.turnId) as (TokenColumns & {
      llm_call_id: string;
      position: number;
      model: string | null;
      stop_reason: StopReason | null;
      failed: number;
      attempt: number | null;
      started_at_us: number;
      started_at_estimated: number;
      ended_at_us: number;
    })[];
    return rows.map((row) => ({
      id: row.llm_call_id,
      position: row.position,
      failed: row.failed === 1,
      startedAtUs: row.started_at_us,
      startedAtEstimated: row.started_at_estimated === 1,
      endedAtUs: row.ended_at_us,
      usage: toUsage(row),
      ...(row.model === null ? {} : { model: row.model }),
      ...(row.stop_reason === null ? {} : { stopReason: row.stop_reason }),
      ...(row.attempt === null ? {} : { attempt: row.attempt }),
    }));
  }

  listToolCalls(key: TurnKey): readonly ToolCallView[] {
    const rows = this.#r(
      `SELECT tc.llm_call_id, tc.ordinal, tc.tool_use_id, tc.name, tc.result_event_id, tc.is_error,
         tc.started_at_us, tc.ended_at_us, tc.subagent_id, sub.pk AS subagent_pk
       FROM tool_call tc
       JOIN llm_call c ON c.agent_pk = tc.agent_pk AND c.llm_call_id = tc.llm_call_id
       JOIN agent a ON a.pk = tc.agent_pk
       LEFT JOIN agent sub ON sub.session_pk = a.session_pk AND sub.agent_id = tc.subagent_id
       WHERE c.agent_pk = ? AND c.turn_id = ?
       ORDER BY c.position, tc.ordinal`,
    ).all(key.agentPk, key.turnId) as {
      llm_call_id: string;
      ordinal: number;
      tool_use_id: string;
      name: string;
      result_event_id: string | null;
      is_error: number | null;
      started_at_us: number;
      ended_at_us: number | null;
      subagent_id: string | null;
      subagent_pk: number | null;
    }[];
    return rows.map((row) => ({
      ordinal: row.ordinal,
      id: row.tool_use_id,
      llmCallId: row.llm_call_id,
      name: row.name,
      startedAtUs: row.started_at_us,
      ...(row.result_event_id === null ? {} : { resultEventId: row.result_event_id }),
      ...(row.is_error === null ? {} : { isError: row.is_error === 1 }),
      ...(row.ended_at_us === null ? {} : { endedAtUs: row.ended_at_us }),
      ...(row.subagent_id === null ? {} : { subagentId: row.subagent_id }),
      ...(row.subagent_pk === null ? {} : { subagentPk: row.subagent_pk }),
    }));
  }

  listCompactions(key: TurnKey): readonly CompactionView[] {
    const rows = this.#r(
      `SELECT compaction_id, position, summary_event_id, trigger, context_tokens_before, model,
         started_at_us, ended_at_us, ${TOKEN_COLUMNS}
       FROM compaction WHERE agent_pk = ? AND turn_id = ? ORDER BY position`,
    ).all(key.agentPk, key.turnId) as (TokenColumns & {
      compaction_id: string;
      position: number;
      summary_event_id: string | null;
      trigger: "auto" | "manual" | null;
      context_tokens_before: number | null;
      model: string | null;
      started_at_us: number;
      ended_at_us: number | null;
    })[];
    return rows.map((row) => ({
      id: row.compaction_id,
      position: row.position,
      startedAtUs: row.started_at_us,
      usage: toUsage(row),
      ...(row.summary_event_id === null ? {} : { summaryEventId: row.summary_event_id }),
      ...(row.trigger === null ? {} : { trigger: row.trigger }),
      ...(row.context_tokens_before === null
        ? {}
        : { contextTokensBefore: row.context_tokens_before }),
      ...(row.model === null ? {} : { model: row.model }),
      ...(row.ended_at_us === null ? {} : { endedAtUs: row.ended_at_us }),
    }));
  }

  findLlmCallCursor(agentPk: number, llmCallId: string): EventCursor | undefined {
    const row = this.#r(
      `SELECT c.turn_id, c.position, t.started_at_us, t.ingest_id
       FROM llm_call c JOIN turn t ON t.agent_pk = c.agent_pk AND t.turn_id = c.turn_id
       WHERE c.agent_pk = ? AND c.llm_call_id = ?`,
    ).get(agentPk, llmCallId) as CursorRow | null;
    return row ? toCursor(row) : undefined;
  }

  findNearestCompaction(agentPk: number, before: EventCursor): EventCursor | undefined {
    const row = this.#r(
      `SELECT m.turn_id, m.position, t.started_at_us, t.ingest_id
       FROM compaction m JOIN turn t ON t.agent_pk = m.agent_pk AND t.turn_id = m.turn_id
       WHERE m.agent_pk = ?1
         AND ((t.started_at_us, t.ingest_id) < (?2, ?3) OR (m.turn_id = ?4 AND m.position < ?5))
       ORDER BY t.started_at_us DESC, t.ingest_id DESC, m.position DESC LIMIT 1`,
    ).get(
      agentPk,
      before.startedAtUs,
      before.ingestId,
      before.turnId,
      before.position,
    ) as CursorRow | null;
    return row ? toCursor(row) : undefined;
  }

  *iterateEventBodies(
    agentPk: number,
    from: EventCursor | undefined,
    to: EventCursor,
  ): Iterable<string> {
    const start = from
      ? `AND ((t.started_at_us, t.ingest_id) > (?6, ?7) OR (e.turn_id = ?8 AND e.position >= ?9))`
      : "";
    const values: SQLQueryBindings[] = [
      agentPk,
      to.startedAtUs,
      to.ingestId,
      to.turnId,
      to.position,
    ];
    if (from) values.push(from.startedAtUs, from.ingestId, from.turnId, from.position);
    const rows = this.#read
      .prepare(
        `SELECT e.body
         FROM event e JOIN turn t ON t.agent_pk = e.agent_pk AND t.turn_id = e.turn_id
         WHERE e.agent_pk = ?1
           AND ((t.started_at_us, t.ingest_id) < (?2, ?3) OR (e.turn_id = ?4 AND e.position < ?5))
           ${start}
         ORDER BY t.started_at_us, t.ingest_id, e.position`,
      )
      .iterate(...values) as IterableIterator<{ body: string }>;
    for (const row of rows) yield row.body;
  }

  findEventBody(agentPk: number, eventId: string): string | undefined {
    const row = this.#r("SELECT body FROM event WHERE agent_pk = ? AND event_id = ?").get(
      agentPk,
      eventId,
    ) as { body: string } | null;
    return row?.body;
  }

  findToolCall(
    agentPk: number,
    llmCallId: string,
    ordinal: number,
  ): { readonly toolUseId: string; readonly resultEventId?: string } | undefined {
    const row = this.#r(
      `SELECT tool_use_id, result_event_id FROM tool_call
       WHERE agent_pk = ? AND llm_call_id = ? AND ordinal = ?`,
    ).get(agentPk, llmCallId, ordinal) as {
      tool_use_id: string;
      result_event_id: string | null;
    } | null;
    if (!row) return undefined;
    return {
      toolUseId: row.tool_use_id,
      ...(row.result_event_id === null ? {} : { resultEventId: row.result_event_id }),
    };
  }

  deleteSession(agentKind: string, sessionId: string): boolean {
    return this.transaction(() => {
      const row = this.#w("SELECT pk FROM session WHERE agent_kind = ? AND session_id = ?").get(
        agentKind,
        sessionId,
      ) as { pk: number } | null;
      if (!row) return false;
      const agents = "SELECT pk FROM agent WHERE session_pk = ?1";
      this.#w(`DELETE FROM tool_call WHERE agent_pk IN (${agents})`).run(row.pk);
      this.#w(`DELETE FROM llm_call WHERE agent_pk IN (${agents})`).run(row.pk);
      this.#w(`DELETE FROM compaction WHERE agent_pk IN (${agents})`).run(row.pk);
      this.#w(`DELETE FROM turn WHERE agent_pk IN (${agents})`).run(row.pk);
      this.#w("DELETE FROM event WHERE session_pk = ?").run(row.pk);
      this.#w("DELETE FROM ingest WHERE session_pk = ?").run(row.pk);
      this.#w("DELETE FROM agent WHERE session_pk = ?").run(row.pk);
      this.#w("DELETE FROM session WHERE pk = ?").run(row.pk);
      return true;
    });
  }
}

interface CursorRow {
  turn_id: string;
  position: number;
  started_at_us: number;
  ingest_id: number;
}

function toCursor(row: CursorRow): EventCursor {
  return {
    turnId: row.turn_id,
    position: row.position,
    startedAtUs: row.started_at_us,
    ingestId: row.ingest_id,
  };
}
