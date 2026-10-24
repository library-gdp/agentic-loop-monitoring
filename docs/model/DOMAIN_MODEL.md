# DOMAIN_MODEL.md

이 문서는 애플리케이션의 도메인 모델과 각 모델이 가진 필드를 정의합니다. 용어의 의미는 [Glossary](GLOSSARY.md)를 따릅니다.

## 개요

도메인 모델은 두 가지로 나뉩니다.

- **Session Log Event**: Plugin이 Session Log의 레코드로 만드는 이벤트입니다. Client Adapter Daemon과 Main Server가 같은 모델을 쓰며, Main Server는 받은 그대로 저장합니다.
- **활동 모델**: Main Server의 Core가 같은 Session의 Session Log Event 순서와 연결 관계로 구성하는 모델입니다. Session, Turn, Loop, LLM Call, Tool Call, Subagent가 있습니다. Session Log Event는 이 모델들을 직접 나타내지 않습니다.

Token Usage는 LLM Call과 활동 모델의 합계에서 쓰는 값입니다.

```
Session
├── Session Log Event (받은 그대로)
└── Turn ◀── user_message
    └── Loop
        ├── LLM Call ◀── assistant_message
        └── Tool Call ◀── tool_use 블록 + tool_result
            └── (Subagent)
```

활동 모델의 필드 가운데 "계산 값"은 저장하지 않고 다른 필드로 계산할 수 있는 값입니다.

## Session Log Event

Session Log Event는 Agent Logging Protocol 버전 `1`에서 Batch의 `events`에 담겨 전송됩니다. 구조를 바꿀 때는 [Agent Logging Protocol의 버전 규칙](AGENT_LOGGING_PROTOCOL.md#버전)을 따릅니다. Main Server가 모르는 값을 다루는 방법은 [알 수 없는 값](AGENT_LOGGING_PROTOCOL.md#알-수-없는-값)을 참고하세요.

Session Log Event는 자신이 속한 Session을 필드로 갖지 않습니다. Session은 그 Session Log Event를 담은 Batch의 `source.agent`와 `session.id`로 정합니다. Session Log Event는 `source.agent`, `session.id`, `event_id`의 조합으로 식별합니다.

버전 `1`로 구성할 수 있는 LLM Call의 input은 [Glossary](GLOSSARY.md)가 정의하는 **모든 것**입니다. 시스템 프롬프트, 지침 파일, Skill, 도구 정의, compaction 결과, Subagent에 넘긴 프롬프트, 사용자 메시지, 이전 모델 응답, 도구 결과가 모두 포함됩니다. 이 문서는 아직 이 가운데 사용자 메시지, 모델 응답, 도구 결과의 Session Log Event만 정의합니다. 나머지도 버전 `1` 안에서 Session Log Event 종류나 선택 필드로 추가합니다. 에이전트가 기록하지 않아 Plugin이 얻을 수 없는 input은 보내지 않습니다.

### 공통 필드

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `event_id` | string | O | Plugin이 붙인 event id입니다. `source.agent`와 `session.id`가 같은 범위 안에서 고유하며, 같은 레코드를 다시 수집해도 바뀌지 않습니다. |
| `type` | string | O | Session Log Event의 종류입니다. `user_message`, `assistant_message`, `tool_result`가 있습니다. |
| `timestamp` | 시각 | O | 에이전트가 레코드를 기록한 시각입니다. 시간대를 포함합니다. |

### `user_message`

사용자가 입력한 프롬프트입니다. Turn은 `user_message`에서 시작합니다.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `text` | string | O | 프롬프트 원문입니다. |

### `assistant_message`

LLM Call 한 번의 응답입니다. `timestamp`는 응답이 기록된 시각입니다.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `model` | string | | 응답한 모델의 이름입니다. |
| `content` | array | O | 응답 내용 블록의 목록입니다. 아래 표를 참고하세요. |
| `usage` | object | | 이 LLM Call의 [Token Usage](#token-usage)입니다. |
| `started_at` | 시각 | | 모델에 요청한 시각입니다. 에이전트가 기록할 때만 넣습니다. |

`content` 블록:

| `type` | 필드 | 설명 |
|---|---|---|
| `text` | `text`: string | 모델이 출력한 텍스트입니다. |
| `reasoning` | `text`: string | 모델의 reasoning입니다. 에이전트가 원문을 기록하지 않으면 블록을 넣지 않습니다. |
| `tool_use` | `tool_use_id`: string, `name`: string, `input`: object | 모델이 요청한 도구 실행입니다. `tool_use_id`는 이 요청을 `tool_result`와 잇는 값입니다. |

### `tool_result`

Tool Call의 실행 결과입니다. `timestamp`는 결과가 기록된 시각입니다.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `tool_use_id` | string | O | 이 결과를 요청한 `tool_use` 블록의 `tool_use_id`입니다. |
| `output` | string 또는 object | O | 도구가 돌려준 결과입니다. |
| `is_error` | boolean | | 도구 실행이 실패했으면 `true`입니다. 에이전트가 기록하지 않으면 뺍니다. |

## Token Usage

LLM Call 한 번에 사용한 토큰 수입니다. 필드는 모두 0 이상의 integer이며 선택입니다. 에이전트가 기록하지 않은 항목은 `0`으로 채우지 않고 뺍니다. 각 항목의 의미는 [Glossary](GLOSSARY.md#metric)를 따릅니다.

| 필드 | 설명 |
|---|---|
| `input_tokens` | Input Token |
| `output_tokens` | Output Token |
| `cache_read_tokens` | Cache Read Token |
| `cache_write_tokens` | Cache Write Token |
| `reasoning_tokens` | Reasoning Token |

## 활동 모델

활동 모델의 id는 그 모델을 만든 Session Log Event의 값을 씁니다. 그래서 같은 Session Log Event를 다시 받아도 같은 활동 모델이 만들어지며, 활동 모델에서 원래의 Session Log Event를 찾아갈 수 있습니다.

### Session

에이전트 프로세스 하나의 대화 단위입니다. Batch의 `source`와 `session`으로 만듭니다.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `agent` | string | O | 에이전트 id입니다. Batch의 `source.agent`입니다. |
| `id` | string | O | 에이전트가 부여한 session id입니다. Batch의 `session.id`입니다. |
| `cwd` | string | | 에이전트의 작업 디렉터리입니다. Batch의 `session.cwd`입니다. |
| `host` | string | | 에이전트가 실행된 머신의 이름입니다. Batch의 `source.host`입니다. |
| `events` | Session Log Event 목록 | O | 이 Session에서 받은 Session Log Event입니다. |
| `turns` | Turn 목록 | O | 이 Session의 Turn입니다. |
| `started_at` | 시각 | 계산 값 | 첫 Turn의 `started_at`입니다. |
| `ended_at` | 시각 | 계산 값 | 마지막 Turn의 `ended_at`입니다. |
| `usage` | Token Usage | 계산 값 | 이 Session의 모든 LLM Call의 Token Usage를 항목별로 더한 값입니다. |

Session은 `agent`와 `id`의 조합으로 식별합니다.

### Turn

사용자 프롬프트 한 번부터 에이전트가 Stop할 때까지의 구간입니다. `user_message` 하나와 그 뒤의 Session Log Event로 만듭니다.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `id` | string | O | Turn을 시작한 `user_message`의 `event_id`입니다. |
| `prompt` | string | O | `user_message`의 `text`입니다. |
| `status` | string | O | `completed` 또는 `errored`입니다. 아래 구성 규칙을 참고하세요. |
| `loops` | Loop 목록 | O | 이 Turn의 Loop입니다. 모델이 응답하기 전에 끝난 Turn이면 비어 있습니다. |
| `started_at` | 시각 | O | `user_message`의 `timestamp`입니다. |
| `ended_at` | 시각 | O | 이 Turn의 마지막 Session Log Event의 `timestamp`입니다. |
| `usage` | Token Usage | 계산 값 | 이 Turn의 모든 LLM Call의 Token Usage를 항목별로 더한 값입니다. |

구성 규칙:

- Batch는 끝난 Turn만 담으며, Turn 하나가 여러 Batch에 나뉘지 않습니다. 사용자가 중단한 Turn은 Plugin이 걸러내므로 오지 않습니다([Plugin Specification](PLUGIN_SPEC.md#turn-단위) 참고). 그래서 Core는 Batch 안에서 Turn을 나누며, 진행 중인 Turn을 두지 않습니다.
- `user_message`가 Turn을 시작합니다.
- Turn은 다음 `user_message` 바로 앞이나 Batch의 끝에서 끝납니다.
- Turn의 마지막 Session Log Event가 `tool_use` 블록이 없는 `assistant_message`(최종 응답)이면 `completed`입니다. 그렇지 않으면 오류나 충돌로 끝난 Turn이며 `errored`입니다.

### Loop

Turn 안에서 LLM Call 한 번과, 그 응답이 요청한 Tool Call들의 묶음입니다.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `id` | string | O | 이 Loop의 LLM Call의 `id`입니다. |
| `llm_call` | LLM Call | O | 이 Loop의 LLM Call입니다. |
| `tool_calls` | Tool Call 목록 | O | LLM Call이 요청한 Tool Call입니다. 요청한 순서를 따르며, 최종 응답이면 비어 있습니다. |
| `started_at` | 시각 | 계산 값 | LLM Call의 `started_at`입니다. |
| `ended_at` | 시각 | 계산 값 | LLM Call의 `ended_at`과 Tool Call들의 `ended_at` 가운데 가장 늦은 시각입니다. |

### LLM Call

모델에 대한 요청과 응답 한 번입니다. `assistant_message` 하나로 만듭니다.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `id` | string | O | `assistant_message`의 `event_id`입니다. |
| `model` | string | | `assistant_message`의 `model`입니다. |
| `input` | Session Log Event 목록 | O | 이 요청으로 모델에 들어간 것입니다. 같은 Session에서 이 `assistant_message` 앞에 있는 Session Log Event로 구성합니다. |
| `output` | `content` 블록 목록 | O | `assistant_message`의 `content`입니다. 모델이 출력한 텍스트, reasoning, 도구 실행 요청을 담습니다. |
| `usage` | Token Usage | | `assistant_message`의 `usage`입니다. |
| `started_at` | 시각 | O | `assistant_message`의 `started_at`입니다. 없으면 바로 앞 Session Log Event의 `timestamp`로 추정합니다. |
| `ended_at` | 시각 | O | `assistant_message`의 `timestamp`입니다. |

### Tool Call

LLM Call이 요청한 도구 실행 한 번입니다. `assistant_message`의 `tool_use` 블록과, 같은 `tool_use_id`를 가진 `tool_result`로 만듭니다.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `id` | string | O | `tool_use` 블록의 `tool_use_id`입니다. |
| `llm_call_id` | string | O | 이 Tool Call을 요청한 LLM Call의 `id`입니다. |
| `name` | string | O | `tool_use` 블록의 `name`입니다. |
| `input` | object | O | `tool_use` 블록의 `input`입니다. 도구에 넘긴 인자입니다. |
| `result_event_id` | string | | `tool_result`의 `event_id`입니다. 결과가 기록되지 않았으면 비웁니다. |
| `output` | string 또는 object | | `tool_result`의 `output`입니다. 결과가 기록되지 않았으면 비웁니다. |
| `is_error` | boolean | | `tool_result`의 `is_error`입니다. 에이전트가 기록하지 않았으면 비웁니다. |
| `started_at` | 시각 | O | 요청한 `assistant_message`의 `timestamp`입니다. 에이전트가 도구 실행을 시작한 시각을 기록하지 않으므로 요청 시각으로 대신합니다. |
| `ended_at` | 시각 | | `tool_result`의 `timestamp`입니다. 결과가 기록되지 않았으면 비웁니다. |
| `subagent` | Subagent | | 이 Tool Call이 띄운 Subagent입니다. |

### Subagent

에이전트가 작업 중에 띄운 하위 에이전트입니다. 자신을 띄운 Tool Call과 연결되며, 자체적인 Loop를 가집니다.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `tool_call_id` | string | O | 이 Subagent를 띄운 Tool Call의 `id`입니다. |
| `loops` | Loop 목록 | O | Subagent의 Loop입니다. |

Agent Logging Protocol에는 아직 Subagent를 부모 Tool Call과 잇는 필드가 없습니다. 그래서 Core는 지금 Subagent를 구성하지 않습니다.

## 결정되지 않은 사항

- 시스템 프롬프트, 지침 파일, Skill, 도구 정의, compaction 결과, Subagent에 넘긴 프롬프트를 나타내는 Session Log Event의 형식
- 에이전트의 원본 레코드를 Session Log Event에 함께 실을지 여부
- Subagent를 부모 Tool Call과 잇는 필드와, Subagent의 Session Log Event를 부모 Session에 연결하는 방법
- LLM Call의 `input`에 앞선 Session Log Event를 어디까지 넣을지. 예를 들어 compaction 이전의 내용을 넣을지
- 여러 Batch에 걸친 Turn의 순서를 Core가 정하는 기준. 한 Batch 안의 순서는 `events`의 순서를 따릅니다.
- Token Usage를 더할 때, 일부 LLM Call만 기록한 항목을 어떻게 다룰지
- Batch의 `source.plugin_version`을 도메인 모델에 남길지
