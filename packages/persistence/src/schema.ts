/** 스키마 버전별 마이그레이션입니다. 배열의 위치 + 1이 그 마이그레이션을 마친 PRAGMA user_version입니다. */
export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE session (
  pk         INTEGER PRIMARY KEY,
  agent_kind TEXT    NOT NULL,
  session_id TEXT    NOT NULL,
  cwd        TEXT,
  host       TEXT,
  UNIQUE (agent_kind, session_id)
) STRICT;

CREATE TABLE agent (
  pk              INTEGER PRIMARY KEY,
  session_pk      INTEGER NOT NULL REFERENCES session (pk),
  agent_id        TEXT    NOT NULL,
  parent_agent_id TEXT,
  UNIQUE (session_pk, agent_id)
) STRICT;

CREATE TABLE ingest (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  transport_unit_id TEXT    NOT NULL,
  protocol_version  INTEGER NOT NULL,
  plugin_version    TEXT    NOT NULL,
  session_pk        INTEGER NOT NULL REFERENCES session (pk),
  agent_pk          INTEGER NOT NULL REFERENCES agent (pk),
  received_at_us    INTEGER NOT NULL,
  event_count       INTEGER NOT NULL,
  stored_count      INTEGER NOT NULL,
  dropped_count     INTEGER NOT NULL,
  CHECK (stored_count >= 0 AND dropped_count >= 0
         AND stored_count + dropped_count <= event_count)
) STRICT;
CREATE INDEX ingest_by_session ON ingest (session_pk);
CREATE INDEX ingest_by_agent   ON ingest (agent_pk);

CREATE TABLE event (
  pk           INTEGER PRIMARY KEY,
  session_pk   INTEGER NOT NULL REFERENCES session (pk),
  event_id     TEXT    NOT NULL,
  agent_pk     INTEGER NOT NULL REFERENCES agent (pk),
  turn_id      TEXT    NOT NULL,
  position     INTEGER NOT NULL CHECK (position >= 0),
  type         TEXT    NOT NULL,
  timestamp_us INTEGER NOT NULL,
  body         TEXT    NOT NULL CHECK (json_valid(body)),
  ingest_id    INTEGER NOT NULL REFERENCES ingest (id),
  UNIQUE (session_pk, event_id)
) STRICT;
CREATE INDEX event_by_turn   ON event (agent_pk, turn_id, position);
CREATE INDEX event_by_ingest ON event (ingest_id);

CREATE TABLE turn (
  agent_pk      INTEGER NOT NULL REFERENCES agent (pk),
  turn_id       TEXT    NOT NULL,
  status        TEXT    NOT NULL
                CHECK (status IN ('completed', 'interrupted', 'errored', 'in_progress')),
  started_at_us INTEGER NOT NULL,
  ended_at_us   INTEGER NOT NULL,
  ingest_id     INTEGER NOT NULL REFERENCES ingest (id),
  PRIMARY KEY (agent_pk, turn_id)
) STRICT;
CREATE INDEX turn_by_time   ON turn (agent_pk, started_at_us);
CREATE INDEX turn_by_ingest ON turn (ingest_id);
CREATE INDEX turn_in_progress ON turn (agent_pk) WHERE status = 'in_progress';

CREATE TABLE llm_call (
  agent_pk             INTEGER NOT NULL,
  llm_call_id          TEXT    NOT NULL,
  turn_id              TEXT    NOT NULL,
  position             INTEGER NOT NULL CHECK (position > 0),
  model                TEXT,
  stop_reason          TEXT    CHECK (stop_reason IS NULL OR stop_reason IN
                                 ('end_turn', 'tool_use', 'max_tokens', 'refusal', 'other')),
  failed               INTEGER NOT NULL CHECK (failed IN (0, 1)),
  attempt              INTEGER CHECK (attempt IS NULL OR attempt >= 1),
  started_at_us        INTEGER NOT NULL,
  started_at_estimated INTEGER NOT NULL CHECK (started_at_estimated IN (0, 1)),
  ended_at_us          INTEGER NOT NULL,
  input_tokens         INTEGER CHECK (input_tokens       IS NULL OR input_tokens       >= 0),
  output_tokens        INTEGER CHECK (output_tokens      IS NULL OR output_tokens      >= 0),
  cache_read_tokens    INTEGER CHECK (cache_read_tokens  IS NULL OR cache_read_tokens  >= 0),
  cache_write_tokens   INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  reasoning_tokens     INTEGER CHECK (reasoning_tokens   IS NULL OR reasoning_tokens   >= 0),
  PRIMARY KEY (agent_pk, llm_call_id),
  FOREIGN KEY (agent_pk, turn_id) REFERENCES turn (agent_pk, turn_id)
) STRICT;
CREATE INDEX llm_call_by_turn ON llm_call (agent_pk, turn_id, position);

CREATE TABLE tool_call (
  agent_pk        INTEGER NOT NULL,
  llm_call_id     TEXT    NOT NULL,
  ordinal         INTEGER NOT NULL CHECK (ordinal >= 0),
  tool_use_id     TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  result_event_id TEXT,
  is_error        INTEGER CHECK (is_error IS NULL OR is_error IN (0, 1)),
  started_at_us   INTEGER NOT NULL,
  ended_at_us     INTEGER,
  subagent_id     TEXT,
  PRIMARY KEY (agent_pk, llm_call_id, ordinal),
  FOREIGN KEY (agent_pk, llm_call_id) REFERENCES llm_call (agent_pk, llm_call_id),
  CHECK ((result_event_id IS NULL) = (ended_at_us IS NULL))
) STRICT;

CREATE TABLE compaction (
  agent_pk              INTEGER NOT NULL,
  compaction_id         TEXT    NOT NULL,
  turn_id               TEXT    NOT NULL,
  position              INTEGER NOT NULL CHECK (position > 0),
  summary_event_id      TEXT,
  trigger               TEXT    CHECK (trigger IS NULL OR trigger IN ('auto', 'manual')),
  context_tokens_before INTEGER CHECK (context_tokens_before IS NULL OR context_tokens_before >= 0),
  model                 TEXT,
  started_at_us         INTEGER NOT NULL,
  ended_at_us           INTEGER,
  input_tokens          INTEGER CHECK (input_tokens       IS NULL OR input_tokens       >= 0),
  output_tokens         INTEGER CHECK (output_tokens      IS NULL OR output_tokens      >= 0),
  cache_read_tokens     INTEGER CHECK (cache_read_tokens  IS NULL OR cache_read_tokens  >= 0),
  cache_write_tokens    INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  reasoning_tokens      INTEGER CHECK (reasoning_tokens   IS NULL OR reasoning_tokens   >= 0),
  PRIMARY KEY (agent_pk, compaction_id),
  FOREIGN KEY (agent_pk, turn_id) REFERENCES turn (agent_pk, turn_id),
  CHECK ((summary_event_id IS NULL) = (ended_at_us IS NULL))
) STRICT;
CREATE INDEX compaction_by_turn ON compaction (agent_pk, turn_id, position);

CREATE TABLE derivation (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
) STRICT;
`,
];
