# DATA_STORAGE.md

이 문서는 [Data Architecture](../model/DATA_ARCHITECTURE.md)가 정한 Main Server의 데이터를 저장하는 방안을 정합니다. 데이터의 구분과 쓰기, 읽기 규칙은 model 문서를 따르며, 이 문서는 바꾸지 않습니다. 이 문서의 내용은 Main Server의 Persistence 모듈이 구현합니다([Application Architecture](../model/APPLICATION_ARCHITECTURE.md#persistence) 참고). 용어는 [Glossary](../model/GLOSSARY.md)를 따릅니다.

## 저장소

Main Server의 데이터를 SQLite 데이터베이스 파일 하나에 저장합니다. 결정 배경은 [Store Main Server data in SQLite](../../adr/2026-10-28-store-main-server-data-in-sqlite.md)를 참고하세요.

| 설정 | 값 | 이유 |
|---|---|---|
| `journal_mode` | `WAL` | Batch를 쓰는 동안에도 Visualization의 질의가 읽을 수 있게 합니다. |
| `synchronous` | `FULL` | `accepted`를 보낸 Batch가 전원이 꺼져도 남게 합니다. |
| `foreign_keys` | `ON` | |
| `busy_timeout` | 설정 값 | 쓰기 잠금을 기다리는 최대 시간입니다. 넘으면 Batch를 `unavailable`로 거절합니다. |

### 설정

| 항목 | 설명 |
|---|---|
| 데이터 파일 | SQLite 데이터베이스 파일의 경로입니다. |
| 쓰기 잠금 대기 시간 | `busy_timeout`입니다. Daemon의 Ack 타임아웃보다 짧아야 합니다. |

## 스키마

[Data Architecture의 Entity](../model/DATA_ARCHITECTURE.md#entity-목록)마다 테이블을 하나씩 둡니다. 열 이름은 Entity의 필드 이름을 따르되 다음은 바꿉니다.

| Entity의 필드 | 열 |
|---|---|
| 참조 필드 `session`, `agent` | 대상 테이블의 대리 키 `session_pk`, `agent_pk` |
| 참조 필드 `ingest` | `ingest_id` |
| Session의 `agent`, `id` | `agent_kind`, `session_id` |
| Agent의 `id`, `parent_id` | `agent_id`, `parent_agent_id` |
| Turn, LLM Call의 `id` | `turn_id`, `llm_call_id` |
| Tool Call의 `id` | `tool_use_id` |
| 시각 필드 | 이름 뒤에 `_us`(예: `started_at_us`) |
| LLM Call의 `usage` | Token Usage 항목마다 열 하나(`input_tokens` 등) |

시각은 모두 UTC 기준 Unix epoch 마이크로초의 `INTEGER`로 저장해 정렬에 씁니다. 원래의 시각 문자열과 시간대는 원문(`event.body`)에 남아 있습니다.

### 원본 데이터

```sql
-- 수신 기록. id가 Main Server가 Batch를 받은 순서입니다.
CREATE TABLE ingest (
  id               INTEGER PRIMARY KEY,
  batch_id         TEXT    NOT NULL,     -- 같은 Batch를 다시 받으면 같은 값이 또 들어옵니다.
  protocol_version INTEGER NOT NULL,
  plugin_version   TEXT    NOT NULL,     -- source.plugin_version
  session_pk       INTEGER NOT NULL REFERENCES session(pk),
  agent_pk         INTEGER NOT NULL REFERENCES agent(pk),
  received_at      INTEGER NOT NULL,
  event_count      INTEGER NOT NULL,     -- Batch의 events 수
  stored_count     INTEGER NOT NULL,     -- 새로 저장한 수
  dropped_count    INTEGER NOT NULL      -- 잘못되어 버린 수
);

CREATE TABLE session (
  pk         INTEGER PRIMARY KEY,
  agent_kind TEXT NOT NULL,              -- source.agent (에이전트 id)
  session_id TEXT NOT NULL,              -- session.id
  cwd        TEXT,
  host       TEXT,                       -- source.host
  UNIQUE (agent_kind, session_id)
);

CREATE TABLE agent (
  pk              INTEGER PRIMARY KEY,
  session_pk      INTEGER NOT NULL REFERENCES session(pk),
  agent_id        TEXT    NOT NULL,      -- agent.id
  parent_agent_id TEXT,                  -- agent.parent_id. 부모가 아직 없을 수 있어 외래 키로 두지 않습니다.
  UNIQUE (session_pk, agent_id)
);

CREATE TABLE event (
  pk            INTEGER PRIMARY KEY,
  session_pk    INTEGER NOT NULL REFERENCES session(pk),
  event_id      TEXT    NOT NULL,
  agent_pk      INTEGER NOT NULL REFERENCES agent(pk),
  turn_id       TEXT    NOT NULL,        -- 소속 Turn: Turn을 시작한 user_message의 event_id
  position      INTEGER NOT NULL,        -- Turn 안 위치. user_message가 0
  type          TEXT    NOT NULL,        -- body의 type
  timestamp_us  INTEGER NOT NULL,        -- body의 timestamp
  body          TEXT    NOT NULL,        -- 받은 Session Log Event의 JSON 원문
  ingest_id     INTEGER NOT NULL REFERENCES ingest(id),
  UNIQUE (session_pk, event_id)
);
CREATE INDEX event_by_turn ON event (agent_pk, turn_id, position);
```

- `event.body`는 Batch의 `events`에 담겨 온 JSON 객체를 바꾸지 않고 저장합니다. 모르는 `type`의 Session Log Event와 모르는 필드도 저장합니다.
- `type`과 `timestamp_us`는 `body`에서 꺼낸 값입니다. 질의와 정렬에만 쓰며 `body`와 다른 값을 넣지 않습니다.
- Session Log Event를 추가할 때는 `INSERT ... ON CONFLICT (session_pk, event_id) DO NOTHING`을 씁니다.
- Session과 Agent의 속성은 비어 있을 때만 채웁니다(예: `UPDATE session SET cwd = ? WHERE pk = ? AND cwd IS NULL`).

### 파생 데이터

```sql
CREATE TABLE turn (
  agent_pk        INTEGER NOT NULL REFERENCES agent(pk),
  turn_id         TEXT    NOT NULL,      -- user_message의 event_id
  status          TEXT    NOT NULL,      -- completed, errored
  started_at_us   INTEGER NOT NULL,
  ended_at_us     INTEGER NOT NULL,
  ingest_id       INTEGER NOT NULL REFERENCES ingest(id),  -- user_message를 처음 저장한 수신 기록
  PRIMARY KEY (agent_pk, turn_id)
);
CREATE INDEX turn_by_time ON turn (agent_pk, started_at_us);

CREATE TABLE llm_call (
  agent_pk            INTEGER NOT NULL REFERENCES agent(pk),
  llm_call_id         TEXT    NOT NULL,  -- assistant_message의 event_id
  turn_id             TEXT    NOT NULL,
  position            INTEGER NOT NULL,  -- assistant_message의 Turn 안 위치
  model               TEXT,
  started_at_us       INTEGER NOT NULL,
  started_at_estimated INTEGER NOT NULL, -- started_at을 앞 Session Log Event로 추정했으면 1
  ended_at_us         INTEGER NOT NULL,
  input_tokens        INTEGER,           -- Token Usage. 기록하지 않은 항목은 NULL
  output_tokens       INTEGER,
  cache_read_tokens   INTEGER,
  cache_write_tokens  INTEGER,
  reasoning_tokens    INTEGER,
  PRIMARY KEY (agent_pk, llm_call_id),
  FOREIGN KEY (agent_pk, turn_id) REFERENCES turn (agent_pk, turn_id)
);
CREATE INDEX llm_call_by_turn ON llm_call (agent_pk, turn_id, position);

CREATE TABLE tool_call (
  agent_pk        INTEGER NOT NULL REFERENCES agent(pk),
  llm_call_id     TEXT    NOT NULL,
  ordinal         INTEGER NOT NULL,      -- 요청 순서
  tool_use_id     TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  result_event_id TEXT,                  -- 결과가 기록되지 않았으면 NULL
  is_error        INTEGER,               -- 기록하지 않았으면 NULL
  started_at_us   INTEGER NOT NULL,
  ended_at_us     INTEGER,
  PRIMARY KEY (agent_pk, llm_call_id, ordinal),
  FOREIGN KEY (agent_pk, llm_call_id) REFERENCES llm_call (agent_pk, llm_call_id)
);

CREATE TABLE derivation (
  version INTEGER NOT NULL               -- 파생 데이터를 만든 구성 규칙의 버전. 행은 하나입니다.
);
```

- 파생 데이터에는 프롬프트, 응답, 도구 인자, 도구 결과를 넣지 않습니다. 이 내용은 `event.body`에서 읽습니다. 예를 들어 Tool Call의 인자는 `llm_call_id`의 `assistant_message`에서, 결과는 `result_event_id`의 `tool_result`에서 읽습니다.
- `tool_call`의 기본 키는 `tool_use_id`가 아니라 요청 순서입니다. `tool_use_id`가 고유한 범위를 정하지 않았기 때문입니다([Data Architecture](../model/DATA_ARCHITECTURE.md#결정되지-않은-사항) 참고).
- Token Usage 합계는 `SUM`으로 계산합니다. `SUM`은 `NULL`을 건너뛰므로, 일부 LLM Call만 기록한 항목의 합계를 어떻게 보여 줄지는 Domain Model이 정할 때 따릅니다. 기록한 LLM Call이 하나도 없는 항목은 `NULL`입니다.

## 쓰기

Batch 하나를 트랜잭션 하나로 처리합니다. [Data Architecture의 쓰기](../model/DATA_ARCHITECTURE.md#쓰기) 3번이 이 트랜잭션입니다.

1. `BEGIN IMMEDIATE`로 쓰기 잠금을 잡습니다. 쓰기 잠금 대기 시간 안에 잡지 못하면 `unavailable`로 거절합니다.
2. `session`, `agent`를 찾거나 추가하고, `ingest`를 추가합니다.
3. `event`를 추가합니다. 중복은 건너뜁니다.
4. Batch에 들어 있는 `turn_id`마다 `turn`, `llm_call`, `tool_call`의 행을 지우고, `event`에서 그 Turn의 행을 `position` 순으로 읽어 다시 만듭니다.
5. `ingest`의 `stored_count`를 채우고 `COMMIT`합니다.
6. `COMMIT`이 끝난 뒤에 `accepted`를 돌려줍니다.

어느 단계에서든 오류가 나면 `ROLLBACK`하고 `unavailable`로 거절합니다.

## 읽기

LLM Call의 input은 같은 `agent_pk`의 `event`를 범위로 읽습니다.

```sql
-- :turn_id, :position 은 대상 LLM Call의 값
SELECT e.body
FROM event e JOIN turn t ON t.agent_pk = e.agent_pk AND t.turn_id = e.turn_id
WHERE e.agent_pk = :agent_pk
  AND (<t가 대상 Turn보다 앞> OR (e.turn_id = :turn_id AND e.position < :position))
ORDER BY <Turn 순서>, e.position;
```

`<Turn 순서>`는 Agent 안 Turn의 순서 기준이 정해지면 그것을 따릅니다([Domain Model](../model/DOMAIN_MODEL.md#결정되지-않은-사항) 참고). `turn` 테이블은 후보가 되는 `started_at_us`와 `ingest_id`를 모두 가지므로, 기준이 정해져도 테이블을 바꾸지 않습니다.

Session 목록의 시작 시각은 그 Session의 `agent`에 속한 `turn.started_at_us`의 최솟값입니다.

## 스키마 버전

- 스키마 버전은 `PRAGMA user_version`에 둡니다. Main Server는 시작할 때 버전을 확인하고, 낮으면 순서대로 마이그레이션한 뒤 Batch를 받습니다.
- 원본 데이터의 테이블은 내용을 잃지 않게 마이그레이션합니다.
- 파생 데이터의 테이블은 마이그레이션하지 않고 지운 뒤 다시 만들어도 됩니다.
- `derivation.version`이 Main Server가 가진 구성 규칙의 버전과 다르면, Main Server는 파생 데이터를 모두 지우고 `event`로 다시 만듭니다. 다시 만드는 동안 받은 Batch는 `unavailable`로 거절합니다.

## Session 삭제

Session 하나를 트랜잭션 하나로 지웁니다. 그 Session의 `tool_call`, `llm_call`, `turn`, `event`, `ingest`, `agent`, `session` 행을 이 순서로 지웁니다.

## 결정되지 않은 사항

- SQLite에 접근하는 라이브러리. Kotlin의 컴파일 대상과 함께 정합니다([Implement the Main Server in Kotlin](../../adr/2026-10-24-implement-main-server-in-kotlin.md)의 범위 밖 참고).
- 데이터 파일의 기본 위치
- 쓰기 잠금 대기 시간의 기본값
- 큰 `event.body`를 압축할지
- 백업 방법(예: `VACUUM INTO`)
