# MAIN_SERVER_API.md

이 문서는 Main Server의 Core가 정의하는 모듈 API인 Ingest API, Query API, Repository API의 명세입니다. 모듈 구성과 의존 관계는 [Application Architecture](APPLICATION_ARCHITECTURE.md)를, 데이터의 필드는 [Domain Model](DOMAIN_MODEL.md)을, 저장하는 데이터와 쓰기, 읽기 규칙은 [Data Architecture](DATA_ARCHITECTURE.md)를 따르며, 이 문서는 그것을 바꾸지 않습니다. Client Adapter Daemon과 Main Server가 주고받는 Batch와 Ack는 [Agent Logging Protocol](AGENT_LOGGING_PROTOCOL.md)이 정의합니다. 용어는 [Glossary](GLOSSARY.md)를 따릅니다.

## 개요

```
Daemon ──Batch──▶ Input Adapter ──Ingest API──▶ Core ◀──Query API── Visualization
                                                  ▲
                                                  │ Repository API (구현)
                                                  │
                                             Persistence
```

| API | 호출하는 모듈 | 구현하는 모듈 | 하는 일 |
|---|---|---|---|
| [Ingest API](#ingest-api) | Input Adapter | Core | Batch 하나의 Session Log Event를 저장합니다. |
| [Query API](#query-api) | Visualization | Core | 저장한 Session, Agent, Turn, Loop, LLM Call, Tool Call과 Token Usage를 조회합니다. |
| [Repository API](#repository-api) | Core | Persistence | 원본 데이터와 파생 데이터를 저장하고 읽습니다. |

Daemon에서 Input Adapter로 가는 화살표를 빼면 화살표는 의존 방향입니다. 세 API 모두 Core가 정의하며, Input Adapter, Visualization, Persistence가 Core에 의존합니다.

## 공통 규칙

### 연산

API는 연산의 묶음입니다. 연산마다 입력, 출력, 오류를 정합니다. 연산을 함수 호출, 메시지, 네트워크 요청 가운데 무엇으로 구현할지는 정하지 않습니다.

### 타입

필드 표의 타입은 [Domain Model](DOMAIN_MODEL.md)과 [Data Architecture](DATA_ARCHITECTURE.md#entity-목록)의 타입을 씁니다. 목록은 `<타입> 목록`으로 씁니다.

### 키

연산의 입력에서 대상을 가리킬 때 다음 키를 씁니다. 키는 [Data Architecture](DATA_ARCHITECTURE.md#entity-목록)의 식별 필드를 그대로 모은 것입니다.

| 키 | 필드 | 설명 |
|---|---|---|
| Session 키 | `agent`, `session_id` | 에이전트 id와 Session ID입니다. |
| Agent 키 | Session 키, `agent_id` | Agent ID입니다. |
| Turn 키 | Agent 키, `turn_id` | Turn의 `id`입니다. |
| LLM Call 키 | Agent 키, `llm_call_id` | LLM Call의 `id`이며 Loop의 `id`이기도 합니다. |
| Tool Call 키 | LLM Call 키, `ordinal` | `assistant_message`의 `content`에서 `tool_use` 블록의 순서입니다. |
| Session Log Event 키 | Session 키, `event_id` | Session Log Event의 `event_id`입니다. |

### 비어 있는 값

에이전트가 기록하지 않았거나 아직 계산할 수 없는 값은 비워서 돌려줍니다. `0`, 빈 문자열, 추정 값으로 채우지 않습니다. 추정한 값은 추정했다고 함께 알립니다(예: LLM Call의 `started_at_estimated`).

## Ingest API

Input Adapter가 Batch를 Core에 넘기는 API입니다. 연산은 `ingest` 하나입니다.

### `ingest`

Batch 하나의 Session Log Event를 저장하고 그 결과를 돌려줍니다.

Input Adapter는 다음을 확인한 뒤에만 `ingest`를 호출합니다. 확인에 실패한 Batch는 `ingest`에 넘기지 않고 [Ack](#ack-대응)로 거절합니다.

- Decoder가 Batch를 해석할 수 있습니다.
- Batch의 필수 필드가 모두 있습니다.
- Main Server가 Batch의 `protocol_version`을 지원합니다.

입력:

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `protocol_version` | integer | O | Batch의 `protocol_version`입니다. |
| `batch_id` | string | O | Batch의 `batch_id`입니다. |
| `source.agent` | string | O | Batch의 `source.agent`입니다. |
| `source.plugin_version` | string | O | Batch의 `source.plugin_version`입니다. |
| `source.host` | string | | Batch의 `source.host`입니다. |
| `session.id` | string | O | Batch의 `session.id`입니다. |
| `session.cwd` | string | | Batch의 `session.cwd`입니다. |
| `agent.id` | string | O | Batch의 `agent.id`입니다. |
| `agent.parent_id` | string | | Batch의 `agent.parent_id`입니다. |
| `events` | 원문 목록 | O | Batch의 `events`입니다. 순서와 내용을 바꾸지 않으며, 모르는 종류와 필드도 그대로 넘깁니다. |

출력:

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `status` | string | O | `accepted` 또는 `rejected`입니다. |
| `event_count` | integer | `accepted`일 때 | `events`에 든 Session Log Event의 수입니다. |
| `stored_count` | integer | `accepted`일 때 | 그 가운데 새로 저장한 수입니다. |
| `dropped_count` | integer | `accepted`일 때 | 그 가운데 잘못되어 버린 수입니다. 나머지는 이미 저장되어 있어 건너뛴 것입니다. |
| `error.code` | string | `rejected`일 때 | 지금은 `unavailable`뿐입니다. |
| `error.message` | string | | 사람이 읽을 설명입니다. |

처리 순서는 [Data Architecture의 쓰기](DATA_ARCHITECTURE.md#쓰기) 2번부터 4번까지입니다. 1번(해석)은 Input Adapter가 `ingest`를 호출하기 전에 끝냅니다.

규칙:

- **영구히 저장한 뒤에 돌려줍니다.** `accepted`는 수신 기록, Session, Agent, Session Log Event와 그 Turn의 파생 데이터가 모두 저장되어 Main Server가 꺼져도 남는 뒤에만 돌려줍니다.
- **원자적입니다.** `rejected`를 돌려주면 그 Batch로는 아무것도 저장하지 않은 것입니다.
- **멱등입니다.** 같은 Batch로 여러 번 호출해도 Session Log Event와 파생 데이터는 처음 한 번 호출한 것과 같습니다. 수신 기록만 호출할 때마다 하나씩 늘어납니다.
- **동시에 호출할 수 있습니다.** 여러 Batch로 동시에 호출해도 같은 Session과 Agent는 하나만 만들어집니다.
- 수신 기록의 `received_at`은 Core가 `ingest` 호출을 받은 시각입니다.
- `accepted`를 돌려준 뒤에는 그 Batch의 Turn을 [Query API](#query-api)로 바로 조회할 수 있습니다.

#### 잘못된 Session Log Event

다음 Session Log Event는 잘못된 것으로 보고 로그를 남긴 뒤 빼고 저장합니다. 나머지는 계속 처리하며, `dropped_count`에 셉니다.

- [공통 필드](DOMAIN_MODEL.md#공통-필드)(`event_id`, `type`, `timestamp`)가 없거나 타입이 맞지 않습니다. `timestamp`가 시간대를 포함하지 않는 경우도 포함합니다.
- Core가 아는 `type`인데, 그 `type`의 필수 필드나 아는 `content` 블록의 필드가 없거나 타입이 맞지 않습니다.

Core가 모르는 `type`의 Session Log Event와 모르는 필드, 모르는 `content` 블록은 잘못된 것이 아닙니다. 원문 그대로 저장하고 활동 모델을 구성할 때 쓰지 않습니다([알 수 없는 값](AGENT_LOGGING_PROTOCOL.md#알-수-없는-값) 참고).

#### `rejected`를 돌려주는 경우

| `error.code` | 경우 |
|---|---|
| `unavailable` | Repository API가 실패했거나, 파생 데이터를 모두 다시 만드는 중이라 Batch를 받을 수 없습니다. |

#### Ack 대응

Input Adapter는 `ingest`의 결과를 다음과 같이 Ack로 바꿉니다. Ack의 형식은 [Agent Logging Protocol](AGENT_LOGGING_PROTOCOL.md#ack)을 따릅니다.

| 상황 | `status` | `error.code` | `retryable` |
|---|---|---|---|
| Decoder가 해석할 수 없거나 필수 필드가 없음 | `rejected` | `invalid_batch` | `false` |
| `protocol_version`을 지원하지 않음 | `rejected` | `unsupported_version` | `true` |
| `ingest`가 `accepted`를 돌려줌 | `accepted` | | |
| `ingest`가 `rejected`를 돌려줌 | `rejected` | `ingest`의 `error.code` | `true` |
| `ingest` 호출이 결과 없이 실패함 | `rejected` | `unavailable` | `true` |

## Query API

Visualization이 저장된 데이터를 조회하는 API입니다. [Intent](../../intent/INTENT-1.0.md#proposed-outcome)의 역추적과 토큰 사용 파악에 필요한 [읽기 질의](DATA_ARCHITECTURE.md#읽기)를 연산으로 제공합니다. Query API는 데이터를 바꾸지 않습니다.

| 연산 | 입력 | 출력 | 답하는 질의 |
|---|---|---|---|
| [`list_sessions`](#list_sessions) | 거르기 조건, 페이지 | [Session 요약](#session-요약) 목록 | Session 목록 |
| [`get_session`](#get_session) | Session 키 | Session 요약, [Agent 요약](#agent-요약) 목록 | Session의 Agent 트리 |
| [`list_turns`](#list_turns) | Agent 키, 페이지 | [Turn 요약](#turn-요약) 목록 | Agent의 Turn 목록 |
| [`get_turn`](#get_turn) | Turn 키 | Turn 요약, [Loop](#loop) 목록 | Turn의 Loop, LLM Call, Tool Call |
| [`get_llm_call`](#get_llm_call) | LLM Call 키 | LLM Call과 output | LLM Call의 output |
| [`list_llm_call_input`](#list_llm_call_input) | LLM Call 키, 페이지 | [Session Log Event 항목](#session-log-event-항목) 목록 | LLM Call의 input |
| [`get_tool_call`](#get_tool_call) | Tool Call 키 | Tool Call과 인자, 결과 | Tool Call의 인자와 결과 |
| [`get_event`](#get_event) | Session Log Event 키 | Session Log Event 항목 | 활동 모델에서 원래의 Session Log Event 찾기 |

LLM Call, Loop, Turn, Agent, Session별 Token Usage 합계는 각 요약의 `usage`로 돌려줍니다.

### 공통 규칙

#### 페이지

목록이 길어질 수 있는 연산은 페이지 단위로 돌려줍니다.

| 입력 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `limit` | integer | | 한 번에 돌려줄 최대 항목 수입니다. 1 이상입니다. |
| `cursor` | string | | 앞선 호출이 돌려준 `next_cursor`입니다. 비우면 처음부터 돌려줍니다. |

| 출력 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `next_cursor` | string | | 다음 페이지를 가리킵니다. 마지막 페이지이면 비웁니다. |

`cursor`는 Core가 만든 값이며, Visualization은 그 내용을 해석하지 않고 그대로 돌려줍니다.

#### 일관성

연산 하나의 결과는 어떤 Batch가 저장되기 전이거나 저장된 뒤의 상태 하나를 보여 줍니다. Batch의 일부만 저장된 상태는 보이지 않습니다. 같은 목록의 페이지를 이어 읽는 사이에 Batch가 저장되면, 이어지는 페이지에 그 Batch의 데이터가 들어갈 수 있습니다.

#### Token Usage 합계

합계는 [Token Usage](DOMAIN_MODEL.md#token-usage)의 항목별로 LLM Call의 `usage`를 더합니다.

- 범위 안의 어느 LLM Call도 기록하지 않은 항목은 비웁니다. `0`으로 채우지 않습니다.
- 일부 LLM Call만 기록한 항목을 어떻게 다룰지는 정하지 않았습니다([Domain Model](DOMAIN_MODEL.md#결정되지-않은-사항) 참고).
- Agent의 합계에는 그 Agent의 Subagent를 더하지 않습니다. Session의 합계에는 그 Session의 모든 Agent를 더합니다.

#### 오류

| `error.code` | 경우 |
|---|---|
| `not_found` | 입력의 키가 가리키는 대상이 없습니다. 목록이 비어 있는 것은 오류가 아닙니다. |
| `invalid_argument` | `limit`이 1보다 작거나, `cursor`를 해석할 수 없거나, 키의 필드가 빠졌습니다. |
| `unavailable` | Repository API가 실패했거나, 파생 데이터를 모두 다시 만드는 중입니다. |

### 출력 타입

#### Session 요약

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `agent` | string | O | 에이전트 id입니다. |
| `id` | string | O | Session ID입니다. |
| `cwd` | string | | 에이전트의 작업 디렉터리입니다. |
| `host` | string | | 에이전트가 실행된 머신의 이름입니다. |
| `started_at` | 시각 | | Session의 `started_at`입니다. Turn이 하나도 없으면 비웁니다. |
| `ended_at` | 시각 | | Session의 `ended_at`입니다. Turn이 하나도 없으면 비웁니다. |
| `usage` | Token Usage | | Session의 Token Usage 합계입니다. |

#### Agent 요약

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `id` | string | O | Agent ID입니다. |
| `parent_id` | string | | 부모 Agent ID입니다. Main Agent이면 비웁니다. |
| `started_at` | 시각 | | Agent의 `started_at`입니다. Turn이 하나도 없으면 비웁니다. |
| `ended_at` | 시각 | | Agent의 `ended_at`입니다. Turn이 하나도 없으면 비웁니다. |
| `usage` | Token Usage | | Agent의 Token Usage 합계입니다. Subagent의 Token Usage는 더하지 않습니다. |

#### Turn 요약

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `id` | string | O | Turn의 `id`입니다. |
| `prompt` | string | O | Turn의 `prompt`입니다. |
| `status` | string | O | `completed` 또는 `errored`입니다. |
| `started_at` | 시각 | O | Turn의 `started_at`입니다. |
| `ended_at` | 시각 | O | Turn의 `ended_at`입니다. |
| `usage` | Token Usage | | Turn의 Token Usage 합계입니다. |

#### Loop

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `id` | string | O | Loop의 `id`입니다. LLM Call의 `id`와 같습니다. |
| `started_at` | 시각 | O | Loop의 `started_at`입니다. |
| `ended_at` | 시각 | O | Loop의 `ended_at`입니다. |
| `llm_call` | [LLM Call 요약](#llm-call-요약) | O | 이 Loop의 LLM Call입니다. |
| `tool_calls` | [Tool Call 요약](#tool-call-요약) 목록 | O | 이 Loop의 Tool Call입니다. `ordinal` 순이며, 최종 응답이면 비어 있습니다. |

#### LLM Call 요약

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `id` | string | O | LLM Call의 `id`입니다. |
| `turn_id` | string | O | 소속 Turn의 `id`입니다. |
| `model` | string | | 응답한 모델의 이름입니다. |
| `started_at` | 시각 | O | LLM Call의 `started_at`입니다. |
| `started_at_estimated` | boolean | O | `started_at`을 추정했으면 `true`입니다. |
| `ended_at` | 시각 | O | LLM Call의 `ended_at`입니다. |
| `usage` | Token Usage | | LLM Call의 Token Usage입니다. Loop의 Token Usage이기도 합니다. |

#### Tool Call 요약

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `llm_call_id` | string | O | 이 Tool Call을 요청한 LLM Call의 `id`입니다. |
| `ordinal` | integer | O | `tool_use` 블록의 순서입니다. |
| `id` | string | O | `tool_use` 블록의 `tool_use_id`입니다. |
| `name` | string | O | 도구 이름입니다. |
| `is_error` | boolean | | 도구 실행이 실패했으면 `true`입니다. 에이전트가 기록하지 않았으면 비웁니다. |
| `result_event_id` | string | | `tool_result`의 `event_id`입니다. 결과가 기록되지 않았으면 비웁니다. |
| `started_at` | 시각 | O | Tool Call의 `started_at`입니다. |
| `ended_at` | 시각 | | Tool Call의 `ended_at`입니다. 결과가 기록되지 않았으면 비웁니다. |
| `subagent_id` | string | | 이 Tool Call이 띄운 Subagent의 Agent ID입니다. 지금은 채우지 않습니다([Tool Call](DOMAIN_MODEL.md#tool-call) 참고). |

#### Session Log Event 항목

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `agent_id` | string | O | 이 Session Log Event를 담은 Batch의 Agent ID입니다. |
| `event_id` | string | O | Session Log Event의 `event_id`입니다. |
| `turn_id` | string | O | 소속 Turn의 `id`입니다. |
| `position` | integer | O | Turn 안 위치입니다. |
| `type` | string | O | Session Log Event의 `type`입니다. |
| `timestamp` | 시각 | O | Session Log Event의 `timestamp`입니다. |
| `body` | 원문 | O | 받은 Session Log Event입니다. 모르는 종류와 필드도 그대로 돌려줍니다. |

### `list_sessions`

Session 목록을 돌려줍니다.

| 입력 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `agent` | string | | 이 에이전트 id의 Session만 돌려줍니다. |
| `cwd` | string | | `cwd`가 이 값과 같은 Session만 돌려줍니다. |
| `host` | string | | `host`가 이 값과 같은 Session만 돌려줍니다. |
| `limit`, `cursor` | | | [페이지](#페이지)입니다. |

| 출력 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `sessions` | Session 요약 목록 | O | `started_at`이 늦은 Session부터 돌려줍니다. `started_at`이 빈 Session은 끝에 둡니다. |
| `next_cursor` | string | | [페이지](#페이지)입니다. |

거르기 조건을 여러 개 주면 모두 만족하는 Session만 돌려줍니다.

### `get_session`

Session 하나와 그 Session의 Agent를 돌려줍니다.

| 출력 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `session` | Session 요약 | O | |
| `agents` | Agent 요약 목록 | O | 이 Session의 Main Agent와 Subagent입니다. `started_at` 순입니다. |

Agent 트리는 `agents`의 `parent_id`로 구성합니다. `parent_id`가 `agents`에 없는 Agent를 가리킬 수 있습니다. 부모 Agent의 Batch가 아직 오지 않은 경우입니다([Agent 구성 규칙](DOMAIN_MODEL.md#agent) 참고). Main Agent의 Batch가 아직 오지 않았으면 `parent_id`가 빈 Agent가 없을 수도 있습니다.

### `list_turns`

Agent 하나의 Turn을 돌려줍니다.

| 출력 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `turns` | Turn 요약 목록 | O | Agent 안 Turn의 순서를 따릅니다. 이 순서의 기준은 정하지 않았습니다([Domain Model](DOMAIN_MODEL.md#결정되지-않은-사항) 참고). |
| `next_cursor` | string | | [페이지](#페이지)입니다. |

### `get_turn`

Turn 하나와 그 Turn의 Loop, LLM Call, Tool Call을 돌려줍니다. 프롬프트를 뺀 큰 내용(응답, 도구 인자, 도구 결과)은 담지 않습니다. 그 내용은 `get_llm_call`, `get_tool_call`로 읽습니다.

| 출력 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `turn` | Turn 요약 | O | |
| `loops` | Loop 목록 | O | Turn 안 LLM Call의 순서입니다. 모델이 응답하기 전에 끝난 Turn이면 비어 있습니다. |

### `get_llm_call`

LLM Call 하나와 그 output을 돌려줍니다.

| 출력 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `llm_call` | LLM Call 요약 | O | |
| `output` | `content` 블록 목록 | O | `assistant_message`의 `content`입니다. 텍스트, reasoning, 도구 실행 요청을 담으며, 모르는 블록도 그대로 돌려줍니다. |
| `tool_calls` | Tool Call 요약 목록 | O | 이 LLM Call이 요청한 Tool Call입니다. `ordinal` 순입니다. |

### `list_llm_call_input`

LLM Call 하나의 input을 돌려줍니다. input은 같은 Agent에서 그 LLM Call의 `assistant_message` 앞에 있는 Session Log Event입니다([LLM Call의 input](DATA_ARCHITECTURE.md#llm-call의-input) 참고). input은 길어질 수 있으므로 페이지로 나누어 돌려줍니다.

| 출력 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `events` | Session Log Event 항목 목록 | O | 모델에 들어간 순서입니다. Agent 안 Turn의 순서를 따르고, 한 Turn 안에서는 `position` 순입니다. |
| `next_cursor` | string | | [페이지](#페이지)입니다. |

- 범위의 끝은 그 LLM Call의 `assistant_message` 바로 앞입니다.
- 범위의 시작과, 여러 Turn에 걸친 순서는 정하지 않았습니다([Domain Model](DOMAIN_MODEL.md#결정되지-않은-사항) 참고). 정해지면 이 연산이 그 규칙을 따릅니다.

### `get_tool_call`

Tool Call 하나와 그 인자, 결과를 돌려줍니다.

| 출력 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `tool_call` | Tool Call 요약 | O | |
| `input` | object | O | `tool_use` 블록의 `input`입니다. 도구에 넘긴 인자입니다. |
| `output` | string 또는 object | | `tool_result`의 `output`입니다. 결과가 기록되지 않았으면 비웁니다. |

### `get_event`

Session Log Event 하나를 돌려줍니다. 활동 모델의 id와 `result_event_id`로 원래의 Session Log Event를 찾아갈 때 씁니다.

| 출력 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `event` | Session Log Event 항목 | O | |

## Repository API

Core가 원본 데이터와 파생 데이터를 저장하고 읽는 API입니다. Core가 정의하고 Persistence가 구현합니다. Repository API는 [Data Architecture](DATA_ARCHITECTURE.md)의 Entity를 다루며, 어떤 저장소에 어떤 구조로 저장하는지는 드러내지 않습니다.

Repository API는 활동 모델을 구성하지 않습니다. Turn, LLM Call, Tool Call을 Session Log Event로 구성하는 일은 Core가 하고, Repository API는 Core가 구성한 결과를 저장합니다.

### 쓰기 작업

쓰기 연산은 쓰기 작업 안에서만 호출합니다.

- **원자적입니다.** 쓰기 작업 안에서 호출한 연산은 모두 반영되거나 하나도 반영되지 않습니다.
- **영구적입니다.** Repository가 쓰기 작업을 끝냈다고 알리면, 그 내용은 Main Server가 꺼져도 남습니다.
- **격리됩니다.** 쓰기 작업 안의 읽기 연산은 그 작업에서 먼저 쓴 내용을 봅니다. 쓰기 작업 밖의 읽기 연산은 끝나지 않은 쓰기 작업의 내용을 보지 않습니다.
- **동시에 열 수 있습니다.** 여러 쓰기 작업이 동시에 열려도 Repository는 하나씩 차례로 반영한 것과 같은 결과를 냅니다.
- 쓰기 작업을 시작하지 못하거나 끝내지 못하면 `unavailable` 오류를 냅니다. 이때 그 작업의 내용은 하나도 반영되지 않습니다.

### 원본 데이터 쓰기

| 연산 | 입력 | 출력 | 규칙 |
|---|---|---|---|
| `put_session` | Session의 필드 | 저장된 Session | 없으면 추가합니다. 있으면 비어 있는 필드만 채웁니다([필드 채우기](DATA_ARCHITECTURE.md#session과-agent의-필드-채우기)). |
| `put_agent` | Session 키, Agent의 필드 | 저장된 Agent | `put_session`과 같습니다. 부모 Agent가 있는지 검사하지 않습니다. |
| `add_ingest` | 수신 기록의 필드(`id`, `stored_count` 제외) | 수신 기록의 `id` | `id`는 앞서 만든 어떤 수신 기록의 `id`보다 큽니다. Session을 지운 뒤에도 지운 값을 다시 쓰지 않습니다. |
| `add_events` | Agent 키, 수신 기록의 `id`, Session Log Event 목록(`event_id`, `turn_id`, `position`, `type`, `timestamp`, `body`) | 새로 저장한 수 | Session 키와 `event_id`가 같은 Session Log Event가 이미 있으면 내용을 비교하지 않고 건너뜁니다. |
| `set_stored_count` | 수신 기록의 `id`, `stored_count` | | `add_ingest`로 만든 수신 기록의 `stored_count`를 채웁니다. |

`put_session`과 `put_agent`는 저장된 값을 돌려줍니다. 입력과 다른 값이 이미 있으면 Core가 둘을 비교해 로그를 남깁니다.

### 파생 데이터 쓰기

| 연산 | 입력 | 출력 | 규칙 |
|---|---|---|---|
| `replace_turn` | Agent 키, Turn, LLM Call 목록, Tool Call 목록 | | 이 Turn의 Turn, LLM Call, Tool Call을 지우고 입력으로 바꿉니다. |
| `clear_derived` | | | 모든 파생 데이터를 지웁니다. |
| `get_derivation_version` | | 구성 규칙의 버전 | 파생 데이터를 만든 구성 규칙의 버전입니다. 파생 데이터를 만든 적이 없으면 비웁니다. |
| `set_derivation_version` | 구성 규칙의 버전 | | |

### 삭제

| 연산 | 입력 | 출력 | 규칙 |
|---|---|---|---|
| `delete_session` | Session 키 | | Session의 원본 데이터, 파생 데이터, 수신 기록을 모두 지웁니다([삭제와 보관](DATA_ARCHITECTURE.md#삭제와-보관)). 쓰기 작업 하나로 지웁니다. |

### 읽기

읽기 연산은 쓰기 작업 안팎에서 모두 호출할 수 있습니다. 대상이 없으면 오류 없이 빈 값을 돌려줍니다. 목록을 돌려주는 연산 가운데 표에 페이지가 있는 것은 Query API와 같은 [페이지](#페이지) 입력과 출력을 가집니다.

| 연산 | 입력 | 출력 |
|---|---|---|
| `find_sessions` | 거르기 조건(`agent`, `cwd`, `host`), 페이지 | Session 목록. 각 Session의 `started_at`, `ended_at`과 함께 `list_sessions`의 순서로 돌려줍니다. |
| `get_session` | Session 키 | Session |
| `list_agents` | Session 키 | Agent 목록. 각 Agent의 `started_at`, `ended_at`과 함께 돌려줍니다. |
| `list_agent_keys` | | 모든 Agent의 Agent 키 |
| `list_turns` | Agent 키, 페이지 | Turn 목록. Agent 안 Turn의 순서입니다. |
| `get_turn` | Turn 키 | Turn |
| `list_llm_calls` | Turn 키 | LLM Call 목록. `position` 순입니다. |
| `get_llm_call` | LLM Call 키 | LLM Call |
| `list_tool_calls` | Turn 키 또는 LLM Call 키 | Tool Call 목록. LLM Call 순, 그 안에서 `ordinal` 순입니다. |
| `get_tool_call` | Tool Call 키 | Tool Call |
| `list_turn_ids` | Agent 키 | 이 Agent의 Session Log Event가 가진 `turn_id` 목록 |
| `read_turn_events` | Agent 키, `turn_id` | 그 Turn의 Session Log Event 목록. `position` 순입니다. |
| `read_events_before` | LLM Call 키, 페이지 | 그 LLM Call의 [input 범위](DATA_ARCHITECTURE.md#llm-call의-input)에 든 Session Log Event 목록. `list_llm_call_input`의 순서입니다. |
| `get_event` | Session Log Event 키 | Session Log Event |
| `sum_usage` | Session 키, Agent 키, Turn 키 가운데 하나 | 그 범위의 Token Usage 합계. [Token Usage 합계](#token-usage-합계) 규칙을 따릅니다. |

읽기 연산이 돌려주는 Session Log Event는 `agent_id`, `event_id`, `turn_id`, `position`, `type`, `timestamp`, `body`를 가집니다.

### Core가 Repository API를 쓰는 순서

#### Batch 저장

`ingest` 하나를 쓰기 작업 하나로 처리합니다.

1. `put_session`, `put_agent`로 Session과 Agent를 찾거나 추가합니다.
2. `add_ingest`로 수신 기록을 추가합니다.
3. `add_events`로 Session Log Event를 추가합니다. 각 Session Log Event의 `turn_id`와 `position`은 Core가 Batch 안의 순서로 정합니다.
4. Batch에 든 `turn_id`마다 `read_turn_events`로 그 Turn의 Session Log Event를 읽고, Turn, LLM Call, Tool Call을 구성해 `replace_turn`으로 저장합니다.
5. `set_stored_count`로 새로 저장한 수를 채우고 쓰기 작업을 끝냅니다.

4번은 이 Batch의 Session Log Event가 아니라 저장된 Session Log Event로 구성합니다. 그래서 이미 저장된 Session Log Event가 섞인 Batch를 다시 받아도 같은 파생 데이터가 만들어집니다.

#### 파생 데이터 다시 만들기

Main Server가 시작할 때 `get_derivation_version`이 Core가 가진 구성 규칙의 버전과 다르면 파생 데이터를 모두 다시 만듭니다.

1. `clear_derived`로 파생 데이터를 지웁니다.
2. `list_agent_keys`와 `list_turn_ids`로 모든 Turn을 찾고, Turn마다 [Batch 저장](#batch-저장)의 4번과 같이 다시 만듭니다.
3. `set_derivation_version`으로 버전을 바꿉니다.

다시 만드는 일은 쓰기 작업 여러 개로 나눌 수 있습니다. 3번이 끝날 때까지 Ingest API와 Query API는 `unavailable`을 돌려줍니다.

## 결정되지 않은 사항

- Session 삭제를 요청하는 API와 그 API를 호출하는 모듈. Repository API의 `delete_session`은 정했지만, 이를 부르는 Core의 API는 아직 없습니다.
- Visualization이 Main Server와 다른 프로세스(예: 웹 브라우저)에서 동작할 때 Query API를 실어 나르는 방식과 인증
- `limit`의 기본값과 상한
- 큰 원문(`body`, `output`, `input`)을 Query API가 잘라서 돌려줄지
- `events`가 `user_message`로 시작하지 않는 Batch를 `ingest`가 어떻게 처리할지. Turn을 시작하는 `user_message`가 잘못되어 빠진 경우와 함께 정합니다([Data Architecture](DATA_ARCHITECTURE.md#결정되지-않은-사항) 참고).
- Agent 안 Turn의 순서, LLM Call input의 범위 시작, 일부 LLM Call만 기록한 Token Usage 항목의 합계. [Domain Model](DOMAIN_MODEL.md#결정되지-않은-사항)에서 정하며, Query API와 Repository API의 해당 연산이 그 결정을 따릅니다.
