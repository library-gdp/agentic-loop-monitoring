# TABLE_DEFINITION.md

이 문서는 Main Server의 SQLite 데이터베이스에 두는 테이블을 정의합니다. 테이블은 [Data Architecture의 Entity](../model/DATA_ARCHITECTURE.md#entity-목록)를 구현하며, Entity의 필드와 규칙을 바꾸지 않습니다. 저장소 설정과 테이블을 쓰고 읽는 절차는 [Data Storage](DATA_STORAGE.md)를 참고하세요. 용어는 [Glossary](../model/GLOSSARY.md)를 따릅니다.

## 공통 규약

| 항목 | 규약 |
|---|---|
| 테이블 | 모든 테이블은 `STRICT` 테이블입니다. 열에 선언한 타입으로 손실 없이 바꿀 수 없는 값(예: `INTEGER` 열에 `'abc'`)을 넣으면 오류가 납니다. SQLite 3.37.0 이상이 필요합니다. |
| 이름 | 테이블과 열 이름은 소문자 snake_case이며, 테이블 이름은 단수형입니다. |
| 대리 키 | Session과 Agent는 식별 필드가 문자열 여러 개라서 `pk`(`INTEGER PRIMARY KEY`, rowid)를 대리 키로 두고, 다른 테이블은 이 대리 키로 참조합니다. 식별 필드는 `UNIQUE` 제약으로 지킵니다. |
| 참조 열 | `<대상 테이블>_pk`(대리 키 참조) 또는 `ingest_id`(수신 기록 참조)입니다. |
| 시각 | `INTEGER`. UTC 기준 Unix epoch 마이크로초이며, 열 이름은 `_us`로 끝납니다. 원래의 시각 문자열과 시간대는 `event.body`에 남아 있습니다. |
| boolean | `INTEGER`. `0` 또는 `1`이며 `CHECK`로 지킵니다. |
| JSON | `TEXT`. UTF-8 JSON 문자열을 받은 그대로 저장합니다. |
| 비어 있는 값 | `NULL`. 에이전트가 기록하지 않은 값을 `0`이나 빈 문자열로 바꾸지 않습니다. |
| 외래 키 | 모든 외래 키는 `ON DELETE NO ACTION`입니다. 행은 [Session 삭제](DATA_STORAGE.md#session-삭제)의 순서대로 지웁니다. |

## 테이블 목록

| 테이블 | Entity | 구분 | 설명 |
|---|---|---|---|
| [`session`](#session) | Session | 원본 데이터 | 에이전트와의 대화 단위 |
| [`agent`](#agent) | Agent | 원본 데이터 | Session 안의 Main Agent 또는 Subagent |
| [`ingest`](#ingest) | 수신 기록 | 원본 데이터 | 받아서 저장한 Transport Unit 하나의 기록 |
| [`event`](#event) | Session Log Event | 원본 데이터 | 받은 Session Log Event 하나 |
| [`turn`](#turn) | Turn | 파생 데이터 | Agent의 Turn 하나 |
| [`llm_call`](#llm_call) | LLM Call | 파생 데이터 | Turn 안의 LLM Call 하나. Loop를 겸합니다. |
| [`tool_call`](#tool_call) | Tool Call | 파생 데이터 | LLM Call이 요청한 Tool Call 하나 |
| [`compaction`](#compaction) | Compaction | 파생 데이터 | Turn 안의 Compaction 하나 |
| [`derivation`](#derivation) | (없음) | 파생 데이터 | 파생 데이터를 만든 구성 규칙의 버전 |

## 관계

```
session ─┬─< agent ─┬─< event >── ingest
         │          ├─< ingest
         └─< ingest │
                    └─< turn ─┬─< llm_call ─< tool_call
                              └─< compaction
```

`─<`는 1 : N입니다. 외래 키는 다음과 같습니다.

| 자식 테이블 | 열 | 부모 테이블 | 열 |
|---|---|---|---|
| `agent` | `session_pk` | `session` | `pk` |
| `ingest` | `session_pk` | `session` | `pk` |
| `ingest` | `agent_pk` | `agent` | `pk` |
| `event` | `session_pk` | `session` | `pk` |
| `event` | `agent_pk` | `agent` | `pk` |
| `event` | `ingest_id` | `ingest` | `id` |
| `turn` | `agent_pk` | `agent` | `pk` |
| `turn` | `ingest_id` | `ingest` | `id` |
| `llm_call` | `agent_pk`, `turn_id` | `turn` | `agent_pk`, `turn_id` |
| `tool_call` | `agent_pk`, `llm_call_id` | `llm_call` | `agent_pk`, `llm_call_id` |
| `compaction` | `agent_pk`, `turn_id` | `turn` | `agent_pk`, `turn_id` |

외래 키로 두지 않는 연결은 다음과 같습니다.

| 테이블 | 열 | 가리키는 것 | 외래 키로 두지 않는 이유 |
|---|---|---|---|
| `agent` | `parent_agent_id` | 같은 Session의 `agent.agent_id` | 부모 Agent의 Transport Unit이 아직 오지 않았어도 Agent를 저장해야 합니다. |
| `event` | `turn_id` | 같은 Agent의 `turn.turn_id` | `event`는 원본 데이터이고 `turn`은 파생 데이터입니다. 파생 데이터를 지우고 다시 만들어도 원본 데이터에 영향이 없어야 합니다. |
| `tool_call` | `result_event_id` | 같은 Session의 `event.event_id` | 파생 데이터에서 원본 데이터를 가리키는 값입니다. 결과가 기록되지 않았으면 `NULL`입니다. |
| `tool_call` | `subagent_id` | 같은 Session의 `agent.agent_id` | Subagent의 Transport Unit이 아직 오지 않았어도 Tool Call을 만들어야 합니다. |
| `compaction` | `summary_event_id` | 같은 Session의 `event.event_id` | 파생 데이터에서 원본 데이터를 가리키는 값입니다. 요약이 아직 기록되지 않았으면 `NULL`입니다. |

## 원본 데이터

### `session`

Session Entity입니다. Session의 Agent 가운데 어느 하나의 Transport Unit이 처음 올 때 행을 추가합니다.

| # | 열 | 타입 | NULL | 키 | 설명 | Entity 필드 |
|---|---|---|---|---|---|---|
| 1 | `pk` | `INTEGER` | N | PK | 대리 키 | |
| 2 | `agent_kind` | `TEXT` | N | UK1 | 에이전트 id. Transport Unit의 `source.agent` | `agent` |
| 3 | `session_id` | `TEXT` | N | UK1 | Session ID. Transport Unit의 `session.id` | `id` |
| 4 | `cwd` | `TEXT` | Y | | 에이전트의 작업 디렉터리. Transport Unit의 `session.cwd` | `cwd` |
| 5 | `host` | `TEXT` | Y | | 에이전트가 실행된 머신의 이름. Transport Unit의 `source.host` | `host` |

- `cwd`, `host`는 `NULL`일 때만 채웁니다([필드 채우기](../model/DATA_ARCHITECTURE.md#session과-agent의-필드-채우기)).

### `agent`

Agent Entity입니다.

| # | 열 | 타입 | NULL | 키 | 설명 | Entity 필드 |
|---|---|---|---|---|---|---|
| 1 | `pk` | `INTEGER` | N | PK | 대리 키 | |
| 2 | `session_pk` | `INTEGER` | N | UK1, FK | 속한 Session | `session` |
| 3 | `agent_id` | `TEXT` | N | UK1 | Agent ID. Transport Unit의 `agent.id` | `id` |
| 4 | `parent_agent_id` | `TEXT` | Y | | 부모 Agent ID. Transport Unit의 `agent.parent_id`. Main Agent이면 `NULL` | `parent_id` |

- `parent_agent_id`는 `NULL`일 때만 채웁니다.

### `ingest`

수신 기록 Entity입니다. `accepted`로 응답한 Transport Unit마다 행을 하나 추가합니다.

| # | 열 | 타입 | NULL | 키 | 설명 | Entity 필드 |
|---|---|---|---|---|---|---|
| 1 | `id` | `INTEGER` | N | PK | 받은 순서. `AUTOINCREMENT`로 지운 값을 다시 쓰지 않습니다. | `id` |
| 2 | `transport_unit_id` | `TEXT` | N | | Transport Unit의 `transport_unit_id`. 같은 Transport Unit을 다시 받으면 같은 값이 또 들어옵니다. | `transport_unit_id` |
| 3 | `protocol_version` | `INTEGER` | N | | Transport Unit의 `protocol_version` | `protocol_version` |
| 4 | `plugin_version` | `TEXT` | N | | Transport Unit의 `source.plugin_version` | `plugin_version` |
| 5 | `session_pk` | `INTEGER` | N | FK | Transport Unit의 Session | `session` |
| 6 | `agent_pk` | `INTEGER` | N | FK | Transport Unit의 Agent | `agent` |
| 7 | `received_at_us` | `INTEGER` | N | | Main Server가 Transport Unit을 받은 시각 | `received_at` |
| 8 | `event_count` | `INTEGER` | N | | Transport Unit의 `events` 수 | `event_count` |
| 9 | `stored_count` | `INTEGER` | N | | 새로 저장한 수 | `stored_count` |
| 10 | `dropped_count` | `INTEGER` | N | | 잘못되어 버린 수 | `dropped_count` |

- `CHECK (stored_count >= 0 AND dropped_count >= 0 AND stored_count + dropped_count <= event_count)`
- `id`는 [Turn 순서](DATA_STORAGE.md#읽기)의 후보로 쓰이므로, Session을 지운 뒤에도 값이 되돌아가지 않도록 `AUTOINCREMENT`를 씁니다.

### `event`

Session Log Event Entity입니다.

| # | 열 | 타입 | NULL | 키 | 설명 | Entity 필드 |
|---|---|---|---|---|---|---|
| 1 | `pk` | `INTEGER` | N | PK | 대리 키 | |
| 2 | `session_pk` | `INTEGER` | N | UK1, FK | Transport Unit의 Session | `session` |
| 3 | `event_id` | `TEXT` | N | UK1 | `body`의 `event_id` | `event_id` |
| 4 | `agent_pk` | `INTEGER` | N | FK | Transport Unit의 Agent | `agent` |
| 5 | `turn_id` | `TEXT` | N | | 소속 Turn. Transport Unit의 `turn.id`이며, Turn을 시작한 `user_message`의 `event_id` | `turn_id` |
| 6 | `position` | `INTEGER` | N | | Turn 안 위치. `user_message`가 `0`. Transport Unit의 `turn.position`에 `events` 안 순서를 더한 값 | `position` |
| 7 | `type` | `TEXT` | N | | `body`의 `type` | `type` |
| 8 | `timestamp_us` | `INTEGER` | N | | `body`의 `timestamp` | `timestamp` |
| 9 | `body` | `TEXT` | N | | 받은 Session Log Event의 JSON 원문 | `body` |
| 10 | `ingest_id` | `INTEGER` | N | FK | 처음 저장한 수신 기록 | `ingest` |

- `CHECK (position >= 0)`
- `CHECK (json_valid(body))`
- `body`는 모르는 `type`의 Session Log Event와 모르는 필드도 그대로 담습니다. `type`과 `timestamp_us`는 `body`에서 꺼낸 값이며 `body`와 다른 값을 넣지 않습니다.
- 행을 추가할 때는 `INSERT ... ON CONFLICT (session_pk, event_id) DO NOTHING`을 씁니다. 추가한 뒤에는 고치지 않습니다.

## 파생 데이터

파생 데이터의 테이블은 언제든 모든 행을 지우고 `event`로 다시 만들 수 있습니다. 프롬프트, 응답, 도구 인자, 도구 결과는 담지 않으며 `event.body`에서 읽습니다.

### `turn`

Turn Entity입니다. `agent_pk`와 `turn_id`가 같은 `event` 행으로 만듭니다.

| # | 열 | 타입 | NULL | 키 | 설명 | Entity 필드 |
|---|---|---|---|---|---|---|
| 1 | `agent_pk` | `INTEGER` | N | PK, FK | 이 Turn의 Agent | `agent` |
| 2 | `turn_id` | `TEXT` | N | PK | Turn을 시작한 `user_message`의 `event_id` | `id` |
| 3 | `status` | `TEXT` | N | | `completed`, `interrupted`, `errored`, `in_progress` | `status` |
| 4 | `started_at_us` | `INTEGER` | N | | `user_message`의 `timestamp` | `started_at` |
| 5 | `ended_at_us` | `INTEGER` | N | | `position`이 가장 큰 `event`의 `timestamp` | `ended_at` |
| 6 | `ingest_id` | `INTEGER` | N | FK | `user_message`를 처음 저장한 수신 기록 | `ingest` |

- `CHECK (status IN ('completed', 'interrupted', 'errored', 'in_progress'))`
- `CHECK (ended_at_us >= started_at_us)`는 두지 않습니다. 에이전트가 기록한 시각이 거꾸로일 수 있고, 그것도 받은 그대로 보여 줘야 합니다.

### `llm_call`

LLM Call Entity입니다. `type`이 `assistant_message`인 `event` 행 하나로 만듭니다.

| # | 열 | 타입 | NULL | 키 | 설명 | Entity 필드 |
|---|---|---|---|---|---|---|
| 1 | `agent_pk` | `INTEGER` | N | PK, FK | 이 LLM Call의 Agent | `agent` |
| 2 | `llm_call_id` | `TEXT` | N | PK | `assistant_message`의 `event_id`. Loop의 `id` | `id` |
| 3 | `turn_id` | `TEXT` | N | FK | 소속 Turn | `turn_id` |
| 4 | `position` | `INTEGER` | N | | `assistant_message`의 Turn 안 위치 | `position` |
| 5 | `model` | `TEXT` | Y | | `assistant_message`의 `model` | `model` |
| 6 | `stop_reason` | `TEXT` | Y | | `assistant_message`의 `stop_reason` | `stop_reason` |
| 7 | `failed` | `INTEGER` | N | | `assistant_message`에 `error`가 있으면 `1` | `failed` |
| 8 | `attempt` | `INTEGER` | Y | | `assistant_message`의 `attempt` | `attempt` |
| 9 | `started_at_us` | `INTEGER` | N | | `assistant_message`의 `started_at`. 없으면 바로 앞 `event`의 `timestamp` | `started_at` |
| 10 | `started_at_estimated` | `INTEGER` | N | | `started_at_us`를 추정했으면 `1` | `started_at_estimated` |
| 11 | `ended_at_us` | `INTEGER` | N | | `assistant_message`의 `timestamp` | `ended_at` |
| 12 | `input_tokens` | `INTEGER` | Y | | Input Token | `usage.input_tokens` |
| 13 | `output_tokens` | `INTEGER` | Y | | Output Token | `usage.output_tokens` |
| 14 | `cache_read_tokens` | `INTEGER` | Y | | Cache Read Token | `usage.cache_read_tokens` |
| 15 | `cache_write_tokens` | `INTEGER` | Y | | Cache Write Token | `usage.cache_write_tokens` |
| 16 | `reasoning_tokens` | `INTEGER` | Y | | Reasoning Token | `usage.reasoning_tokens` |

- `CHECK (position > 0)`: 위치 `0`은 `user_message`입니다.
- `CHECK (stop_reason IS NULL OR stop_reason IN ('end_turn', 'tool_use', 'max_tokens', 'refusal', 'other'))`
- `CHECK (failed IN (0, 1))`
- `CHECK (attempt IS NULL OR attempt >= 1)`
- `CHECK (started_at_estimated IN (0, 1))`
- 토큰 열마다 `CHECK (<열> IS NULL OR <열> >= 0)`
- 토큰 열은 에이전트가 기록하지 않았으면 `NULL`입니다. 합계는 `SUM`으로 계산하며, `SUM`은 `NULL`을 건너뜁니다.

### `tool_call`

Tool Call Entity입니다. `assistant_message`의 `tool_use` 블록 하나와, 같은 Turn에서 `tool_use_id`가 같은 `tool_result`로 만듭니다.

| # | 열 | 타입 | NULL | 키 | 설명 | Entity 필드 |
|---|---|---|---|---|---|---|
| 1 | `agent_pk` | `INTEGER` | N | PK, FK | 이 Tool Call의 Agent | `agent` |
| 2 | `llm_call_id` | `TEXT` | N | PK, FK | 요청한 LLM Call | `llm_call_id` |
| 3 | `ordinal` | `INTEGER` | N | PK | `content`에서 `tool_use` 블록의 순서. 첫 블록이 `0` | `ordinal` |
| 4 | `tool_use_id` | `TEXT` | N | | `tool_use` 블록의 `tool_use_id` | `id` |
| 5 | `name` | `TEXT` | N | | `tool_use` 블록의 `name` | `name` |
| 6 | `result_event_id` | `TEXT` | Y | | `tool_result`의 `event_id`. 결과가 기록되지 않았으면 `NULL` | `result_event_id` |
| 7 | `is_error` | `INTEGER` | Y | | `tool_result`의 `is_error`. 기록하지 않았으면 `NULL` | `is_error` |
| 8 | `started_at_us` | `INTEGER` | N | | 요청한 `assistant_message`의 `timestamp` | `started_at` |
| 9 | `ended_at_us` | `INTEGER` | Y | | `tool_result`의 `timestamp`. 결과가 기록되지 않았으면 `NULL` | `ended_at` |
| 10 | `subagent_id` | `TEXT` | Y | | `tool_result`의 `subagent_id`. 띄운 Subagent가 없거나 기록되지 않았으면 `NULL` | `subagent_id` |

- `CHECK (ordinal >= 0)`
- `CHECK (is_error IS NULL OR is_error IN (0, 1))`
- `CHECK ((result_event_id IS NULL) = (ended_at_us IS NULL))`: 결과가 있을 때만 끝난 시각이 있습니다.
- 기본 키가 `tool_use_id`가 아닌 이유는 [Data Architecture의 Tool Call](../model/DATA_ARCHITECTURE.md#tool-call)을 참고하세요.

### `compaction`

Compaction Entity입니다. `type`이 `compaction`인 `event` 행 하나와, 같은 Turn에서 그 뒤에 처음 나오는 `compaction_summary`로 만듭니다.

| # | 열 | 타입 | NULL | 키 | 설명 | Entity 필드 |
|---|---|---|---|---|---|---|
| 1 | `agent_pk` | `INTEGER` | N | PK, FK | 이 Compaction의 Agent | `agent` |
| 2 | `compaction_id` | `TEXT` | N | PK | `compaction`의 `event_id` | `id` |
| 3 | `turn_id` | `TEXT` | N | FK | 소속 Turn | `turn_id` |
| 4 | `position` | `INTEGER` | N | | `compaction`의 Turn 안 위치 | `position` |
| 5 | `summary_event_id` | `TEXT` | Y | | `compaction_summary`의 `event_id`. 요약이 기록되지 않았으면 `NULL` | `summary_event_id` |
| 6 | `trigger` | `TEXT` | Y | | `compaction`의 `trigger` | `trigger` |
| 7 | `context_tokens_before` | `INTEGER` | Y | | `compaction`의 `context_tokens_before` | `context_tokens_before` |
| 8 | `model` | `TEXT` | Y | | `compaction_summary`의 `model` | `model` |
| 9 | `started_at_us` | `INTEGER` | N | | `compaction`의 `timestamp` | `started_at` |
| 10 | `ended_at_us` | `INTEGER` | Y | | `compaction_summary`의 `timestamp`. 요약이 기록되지 않았으면 `NULL` | `ended_at` |
| 11 | `input_tokens` | `INTEGER` | Y | | Input Token | `usage.input_tokens` |
| 12 | `output_tokens` | `INTEGER` | Y | | Output Token | `usage.output_tokens` |
| 13 | `cache_read_tokens` | `INTEGER` | Y | | Cache Read Token | `usage.cache_read_tokens` |
| 14 | `cache_write_tokens` | `INTEGER` | Y | | Cache Write Token | `usage.cache_write_tokens` |
| 15 | `reasoning_tokens` | `INTEGER` | Y | | Reasoning Token | `usage.reasoning_tokens` |

- `CHECK (position > 0)`: 위치 `0`은 `user_message`입니다.
- `CHECK (trigger IS NULL OR trigger IN ('auto', 'manual'))`
- `CHECK (context_tokens_before IS NULL OR context_tokens_before >= 0)`
- `CHECK ((summary_event_id IS NULL) = (ended_at_us IS NULL))`: 요약이 있을 때만 끝난 시각이 있습니다.
- 토큰 열마다 `CHECK (<열> IS NULL OR <열> >= 0)`
- 요약 원문은 담지 않으며 `summary_event_id`의 `event.body`에서 읽습니다.

### `derivation`

파생 데이터를 만든 구성 규칙의 버전입니다. 행은 많아야 하나입니다. 행이 없으면 파생 데이터를 아직 만들지 않은 것입니다.

| # | 열 | 타입 | NULL | 키 | 설명 |
|---|---|---|---|---|---|
| 1 | `id` | `INTEGER` | N | PK | 항상 `1` |
| 2 | `version` | `INTEGER` | N | | 구성 규칙의 버전 |

- `CHECK (id = 1)`

## 인덱스

| 인덱스 | 테이블 | 열 | 쓰는 곳 |
|---|---|---|---|
| (UK1) | `session` | `agent_kind`, `session_id` | Transport Unit의 Session 찾기 |
| (UK1) | `agent` | `session_pk`, `agent_id` | Transport Unit의 Agent 찾기, Session의 Agent 트리 |
| (UK1) | `event` | `session_pk`, `event_id` | 중복 판단, `result_event_id`로 결과 찾기, Session 삭제 |
| `event_by_turn` | `event` | `agent_pk`, `turn_id`, `position` | Turn의 파생 데이터 만들기, LLM Call의 input 범위 |
| `event_by_ingest` | `event` | `ingest_id` | Plugin 버전별 Session Log Event 찾기, `ingest` 삭제 때 외래 키 검사 |
| `ingest_by_session` | `ingest` | `session_pk` | Session 삭제 |
| `ingest_by_agent` | `ingest` | `agent_pk` | `agent` 삭제 때 외래 키 검사 |
| `turn_by_time` | `turn` | `agent_pk`, `started_at_us` | Agent의 Turn 목록, Session 목록의 시작 시각 |
| `turn_by_ingest` | `turn` | `ingest_id` | `ingest` 삭제 때 외래 키 검사 |
| `turn_in_progress` | `turn` | `agent_pk` (`status = 'in_progress'`인 행만) | 같은 Agent의 `in_progress` Turn을 찾아 다시 만들기 |
| `llm_call_by_turn` | `llm_call` | `agent_pk`, `turn_id`, `position` | Turn의 Loop 목록 |
| `compaction_by_turn` | `compaction` | `agent_pk`, `turn_id`, `position` | Turn의 Compaction 목록, LLM Call의 input 범위의 시작 |

`tool_call`은 기본 키(`agent_pk`, `llm_call_id`, `ordinal`)로 LLM Call의 Tool Call을 순서대로 찾습니다.

## DDL

```sql
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
```

## 결정되지 않은 사항

- 큰 `event.body`를 압축하거나 따로 저장할지([Data Storage](DATA_STORAGE.md#결정되지-않은-사항) 참고)
- Session 목록을 거르는 열(`agent_kind`, `cwd`, `host`)과 Session의 시작 시각에 인덱스나 미리 계산한 열이 필요한지. Session 수가 늘어 목록 질의가 느려지면 정합니다.
