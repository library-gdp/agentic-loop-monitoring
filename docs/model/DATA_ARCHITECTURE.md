# DATA_ARCHITECTURE.md

이 문서는 시스템이 다루는 데이터가 어디에 있고 누가 소유하는지, Main Server가 데이터를 어떤 구조로 저장하고 어떻게 쓰고 읽는지를 정합니다. 데이터의 필드는 [Domain Model](DOMAIN_MODEL.md)이, Batch와 Ack의 형식은 [Agent Logging Protocol](AGENT_LOGGING_PROTOCOL.md)이 정의하며, 이 문서는 그것을 바꾸지 않습니다. 저장 데이터를 다루는 모듈은 [Application Architecture](APPLICATION_ARCHITECTURE.md)의 Core와 Persistence입니다. 용어는 [Glossary](GLOSSARY.md)를 따릅니다.

## 원칙

1. **Main Server가 기록의 원본을 가집니다.** Session Log는 에이전트가 소유하므로 에이전트가 언제든 지울 수 있고, Daemon은 Ack를 받은 Batch를 보관하지 않습니다. 그래서 Ack 뒤에 Session Log Event가 남는 곳은 Main Server뿐입니다.
2. **받은 것을 바꾸지 않습니다.** Session Log Event는 받은 그대로 저장하고, 저장한 뒤에는 고치지 않습니다. 지우는 것은 [Session 단위 삭제](#삭제와-보관)뿐입니다.
3. **다시 얻을 수 없는 것은 버리지 않습니다.** Main Server가 아직 모르는 Session Log Event 종류, `content` 블록, 필드도 원문에 남깁니다. Core는 이것을 활동 모델을 구성할 때 쓰지 않을 뿐입니다([알 수 없는 값](AGENT_LOGGING_PROTOCOL.md#알-수-없는-값) 참고). 나중에 Main Server가 그 값을 이해하게 되면 다시 수집하지 않고 지난 데이터에도 적용할 수 있습니다.
4. **활동 모델은 파생 데이터입니다.** Turn, Loop, LLM Call, Tool Call은 원본 데이터로 언제든 다시 만들 수 있으며, 원본 데이터와 어긋나면 원본 데이터가 맞습니다.
5. **같은 내용을 여러 번 저장하지 않습니다.** LLM Call의 input은 앞선 Session Log Event를 가리켜 나타내고 복사하지 않습니다([LLM Call의 input](#llm-call의-input) 참고).

## 데이터가 있는 곳

```
┌──────────────── Agent host ────────────────┐      ┌──────────── Main Server ────────────┐
│                                            │      │                                     │
│  Session Log ──▶ Plugin ──▶ Daemon ────────┼─────▶│  원본 데이터 ──derive──▶ 파생 데이터 │
│  (에이전트 소유)   │          (전송 중인     │Batch │  (기록의 원본)          (다시 만듦)   │
│                  ▼           Batch)        │      │                                     │
│             Plugin 상태                    │      │                                     │
└────────────────────────────────────────────┘      └─────────────────────────────────────┘
```

| 데이터 | 위치 | 소유자 | 수명 | 잃으면 |
|---|---|---|---|---|
| Session Log | 에이전트 머신 | 에이전트 | 에이전트가 정합니다. | 아직 수집하지 않은 내용은 유실됩니다. |
| Plugin 상태(수집한 위치 등) | 에이전트 머신 | Plugin | Plugin이 정합니다. | Plugin이 처음부터 다시 수집합니다. 이미 보낸 Session Log Event는 Main Server가 event id로 걸러냅니다. |
| 전송 중인 Batch | Daemon | Daemon | Ack를 받거나 버릴 때까지 | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#ack-처리)을 따릅니다. |
| Daemon 로그 | 에이전트 머신 | Daemon | 정하지 않음 | 운영 기록만 잃습니다. |
| [원본 데이터](#원본-데이터) | Main Server | Core가 규칙을 정하고 Persistence가 저장 | [Session 단위 삭제](#삭제와-보관)까지 | Session Log가 남아 있지 않으면 되살릴 수 없습니다. |
| [파생 데이터](#파생-데이터) | Main Server | Core가 원본 데이터로 계산 | 원본 데이터와 같음 | 원본 데이터로 다시 만듭니다. |

이 문서의 나머지는 Main Server의 데이터를 다룹니다.

## Main Server의 데이터

Main Server의 데이터는 원본 데이터와 파생 데이터로 나뉩니다.

| 구분 | 레코드 | 만드는 것 | 바뀌는가 |
|---|---|---|---|
| 원본 데이터 | Session, Agent, Session Log Event, 수신 기록 | Batch | 추가만 합니다. Session과 Agent의 비어 있는 속성은 채울 수 있습니다. |
| 파생 데이터 | Turn, LLM Call, Tool Call과 계산 값 | 원본 데이터 | 언제든 버리고 다시 만들 수 있습니다. |

### 원본 데이터

Batch에서 얻을 수 있고 다른 데이터로 다시 계산할 수 없는 것입니다.

| 레코드 | 식별 | 내용 |
|---|---|---|
| Session | `source.agent`, `session.id` | `cwd`, `host` |
| Agent | Session, `agent.id` | `parent_id` |
| Session Log Event | Session, `event_id` | 아래 표 |
| 수신 기록 | Main Server가 받은 순서 | Batch의 `batch_id`, `protocol_version`, `source.plugin_version`, 받은 시각, 받은 Session Log Event 수와 그 가운데 새로 저장한 수, 버린 수 |

Session Log Event 레코드는 다음을 가집니다.

| 내용 | 설명 |
|---|---|
| 원문 | Batch에 담겨 온 Session Log Event 그대로입니다. 모르는 종류와 필드도 포함합니다. |
| Agent | 이 Session Log Event를 담은 Batch의 `agent.id`입니다. |
| 소속 Turn | 같은 Batch 안에서 이 Session Log Event 앞에 있는 가장 가까운 `user_message`의 `event_id`입니다. `user_message`는 자기 자신입니다. |
| Turn 안 위치 | 소속 Turn의 `user_message`부터 센 순서입니다. `user_message`가 `0`입니다. |
| 수신 기록 | 이 Session Log Event를 처음 저장한 수신 기록입니다. |

`type`, `timestamp` 같은 값은 원문에서 꺼내 쓸 수 있도록 따로 둘 수 있지만, 원문과 다른 값을 가져서는 안 됩니다.

소속 Turn과 Turn 안 위치는 Session Log Event 자체가 아니라 Batch에서 얻는 정보입니다. [Turn 구성 규칙](DOMAIN_MODEL.md#turn)은 Batch 안의 순서와 Batch의 끝에 기대지만 Batch는 저장하지 않으므로, 원본 데이터만으로 Turn을 다시 만들 수 있도록 이 두 값을 함께 저장합니다.

수신 기록은 Session Log Event가 어느 Plugin 버전으로 만들어졌는지와 어느 `protocol_version`으로 왔는지를 남깁니다. Plugin의 변환 오류로 잘못 만들어진 Session Log Event를 찾을 때 씁니다. `source.plugin_version`을 도메인 모델에 남길지는 정하지 않았으며([Domain Model](DOMAIN_MODEL.md#결정되지-않은-사항) 참고), 수신 기록은 그 결정과 상관없이 값을 남겨 둡니다.

#### Session과 Agent의 속성

같은 Session과 Agent는 여러 Batch에 걸쳐 옵니다. 속성은 다음과 같이 다룹니다.

- 비어 있는 속성은 나중에 온 Batch의 값으로 채웁니다.
- 이미 값이 있는 속성은 바꾸지 않습니다. 다른 값이 오면 로그를 남깁니다.
- Agent의 `parent_id`가 가리키는 부모 Agent가 아직 없어도 Agent를 저장합니다([Agent 구성 규칙](DOMAIN_MODEL.md#agent) 참고). 원본 데이터는 부모 Agent가 있는지 검사하지 않습니다.
- Session은 그 Session의 Agent 가운데 어느 하나의 Batch가 처음 올 때 만듭니다. Main Agent의 Batch가 아직 오지 않은 Session도 있을 수 있습니다.

### 파생 데이터

파생 데이터는 Query API가 활동 모델을 빠르게 돌려주기 위한 색인입니다. [활동 모델](DOMAIN_MODEL.md#활동-모델)의 구성 규칙대로 원본 데이터에서 계산합니다.

| 레코드 | 가지는 것 |
|---|---|
| Turn | id, Agent, `status`, `started_at`, `ended_at`, 처음 저장한 수신 기록 |
| LLM Call | id, Agent, 소속 Turn, Turn 안 위치, `model`, `started_at`, `ended_at`, Token Usage |
| Tool Call | id, 요청한 LLM Call, 요청 순서, `name`, `result_event_id`, `is_error`, `started_at`, `ended_at` |

- Loop는 LLM Call 하나와 그 Tool Call들이므로 따로 두지 않습니다. Loop의 `id`는 LLM Call의 `id`와 같습니다.
- 파생 데이터에는 큰 내용을 담지 않습니다. 프롬프트, 응답, 도구 인자, 도구 결과 같은 내용은 원본 데이터에서 읽습니다. 파생 데이터는 그 내용이 들어 있는 Session Log Event를 가리킵니다.
- Token Usage는 에이전트가 기록한 항목만 가지며, 기록하지 않은 항목은 비워 둡니다. 비어 있는 항목을 `0`으로 바꾸지 않습니다.
- 계산 값(Token Usage 합계, `started_at`과 `ended_at` 등)은 질의할 때 계산합니다. 질의가 느려 미리 계산해 두어야 하면 파생 데이터에 둡니다.
- 파생 데이터는 자신을 만든 구성 규칙의 버전을 가집니다. 구성 규칙이 바뀌면 원본 데이터로 파생 데이터를 모두 다시 만듭니다.

Turn 하나는 한 Batch 안에 온전히 들어 있으므로([Batch 단위](PLUGIN_SPEC.md#batch-단위) 참고), Turn과 그 안의 LLM Call, Tool Call은 그 Turn의 Session Log Event만으로 만들 수 있습니다. 다른 Turn이나 다른 Agent를 읽지 않습니다. Tool Call의 `tool_use` 블록과 `tool_result`도 같은 Turn 안에서 `tool_use_id`로 짝을 맞춥니다.

### LLM Call의 input

LLM Call의 `input`은 같은 Agent에서 그 `assistant_message` 앞에 있는 Session Log Event입니다([LLM Call](DOMAIN_MODEL.md#llm-call) 참고). 이것을 LLM Call마다 복사해 저장하면 Agent의 Session Log Event 수의 제곱만큼 데이터가 늘어납니다. 그래서 input은 저장하지 않고 질의할 때 원본 데이터에서 범위로 읽습니다.

- 범위의 끝은 그 LLM Call의 `assistant_message` 바로 앞입니다. 파생 데이터의 LLM Call이 가진 소속 Turn과 Turn 안 위치로 정합니다.
- 범위의 시작과, 여러 Turn에 걸친 순서는 Core의 규칙으로 정합니다. 두 규칙 모두 아직 정하지 않았습니다([Domain Model](DOMAIN_MODEL.md#결정되지-않은-사항) 참고). 저장 데이터는 이 순서를 굳혀 두지 않고 그 재료(각 Turn의 `started_at`과 처음 저장한 수신 기록의 순서)만 가지므로, 규칙이 정해지거나 바뀌어도 원본 데이터를 고치지 않습니다.

## 쓰기

Core의 Ingest API는 Batch 하나를 다음 순서로 처리합니다.

1. Input Adapter의 Decoder가 Batch를 해석합니다. 해석할 수 없으면 `invalid_batch`로 거절하며, 아무것도 저장하지 않습니다.
2. Session Log Event를 하나씩 검사합니다. 잘못된 Session Log Event는 로그를 남기고 뺍니다([Ack 규칙](AGENT_LOGGING_PROTOCOL.md#규칙) 참고).
3. 다음을 **한 번에 원자적으로** 저장합니다.
   1. 수신 기록을 추가합니다.
   2. Session과 Agent가 없으면 추가하고, [속성 규칙](#session과-agent의-속성)에 따라 비어 있는 속성을 채웁니다.
   3. Session Log Event를 추가합니다. Session과 `event_id`가 같은 Session Log Event가 이미 있으면 내용을 비교하지 않고 건너뜁니다.
   4. 이 Batch에 들어 있는 Turn의 파생 데이터를 다시 만듭니다.
4. 저장이 끝나면 `accepted`를 돌려줍니다. 3번의 어느 단계에서든 실패하면 3번 전체를 되돌리고 `unavailable`로 거절합니다.

- 3번이 원자적이므로, 같은 Batch를 몇 번 다시 받아도 저장 결과는 처음 한 번 받은 것과 같습니다. 일부만 저장된 Batch는 남지 않습니다.
- 파생 데이터를 같은 단계에서 만들므로, `accepted`를 돌려준 Batch는 바로 조회할 수 있습니다. Turn의 파생 데이터는 그 Turn의 Session Log Event만으로 만들므로, 이 비용은 Batch의 크기에만 비례합니다.
- 여러 Daemon이 Main Server 하나에 동시에 Batch를 보낼 수 있습니다. 같은 Session, 같은 Agent를 동시에 추가하려 해도 하나만 만들어져야 합니다.
- 파생 데이터를 모두 다시 만드는 동안 Batch를 받을 수 없으면 `unavailable`로 거절합니다. Daemon이 다시 보냅니다.

## 읽기

Query API가 [Intent](../../intent/INTENT-1.0.md#proposed-outcome)의 역추적과 토큰 사용 파악에 답하려면 다음 질의가 필요합니다. 저장 구조는 이 질의를 Session 전체를 훑지 않고 처리할 수 있어야 합니다.

| 질의 | 읽는 데이터 |
|---|---|
| Session 목록(시작 시각순, 에이전트 id, `cwd`, `host`로 거르기) | 원본 데이터의 Session, 파생 데이터의 Turn 시각 |
| Session의 Agent 트리 | 원본 데이터의 Agent(`parent_id`) |
| Agent의 Turn 목록과 각 Turn의 `status`, Token Usage 합계 | 파생 데이터의 Turn, LLM Call |
| Turn의 Loop, LLM Call, Tool Call | 파생 데이터 |
| LLM Call의 input과 output | 원본 데이터의 Session Log Event([범위](#llm-call의-input)와 그 LLM Call의 `assistant_message`) |
| Tool Call의 인자와 결과 | 원본 데이터의 Session Log Event(`assistant_message`의 `tool_use` 블록과 `tool_result`) |
| LLM Call, Loop, Turn, Agent, Session별 Token Usage 합계 | 파생 데이터의 LLM Call |

Visualization은 이 질의를 Query API로만 합니다([Application Architecture](APPLICATION_ARCHITECTURE.md#visualization) 참고).

## 삭제와 보관

- Main Server는 데이터를 저절로 지우지 않습니다. 보관 기간은 정하지 않았습니다.
- 데이터를 지울 때는 **Session 단위로** 원본 데이터와 파생 데이터, 그 Session의 수신 기록을 함께 지웁니다. LLM Call의 input은 같은 Agent의 앞선 Session Log Event를 모두 가리키고, Subagent는 부모 Agent와 같은 Session에 있으므로, Session의 일부만 지우면 남은 LLM Call의 input과 Agent 트리가 틀어집니다.
- 지운 Session의 Session Log Event를 Daemon이 다시 보내면 다시 저장됩니다. 중복을 걸러내는 근거였던 Session Log Event가 지워졌기 때문입니다.

## 형식이 바뀔 때

| 바뀌는 것 | 처리 |
|---|---|
| 같은 `protocol_version` 안에서 Session Log Event 종류나 선택 필드 추가 | 원본 데이터는 그대로 둡니다. 원문에 이미 들어 있으므로, Core가 새 값을 이해하게 되면 파생 데이터를 다시 만들어 지난 데이터에도 적용합니다. |
| 활동 모델의 구성 규칙 변경 | 원본 데이터는 그대로 두고 파생 데이터를 다시 만듭니다. |
| `protocol_version` 변경 | 원본 데이터는 받은 형식 그대로 둡니다. 어느 `protocol_version`으로 받았는지는 수신 기록으로 압니다. 다른 버전으로 받은 원문을 Core가 어떻게 읽을지는 그 버전을 정할 때 정합니다. |
| 저장 구조 변경 | 원본 데이터는 내용을 잃지 않고 옮깁니다. 파생 데이터는 옮기지 않고 다시 만들어도 됩니다. |

## 보호

[Masking](SYSTEM_ARCHITECTURE.md#masking) 원칙에 따라 프롬프트와 Tool Call 결과의 원문을 그대로 저장합니다. 저장한 데이터의 암호화와 접근 제어는 정하지 않았습니다([Intent](../../intent/INTENT-1.0.md#open-questions)의 1, 2번 참고).

## 결정되지 않은 사항

- 데이터의 보관 기간과 저절로 지우는지 여부
- 지운 Session을 Daemon이 다시 보냈을 때 다시 저장하지 않게 할지
- 시스템 프롬프트, 도구 정의처럼 LLM Call마다 되풀이되는 큰 input을 한 번만 저장하는 방법. 이 input을 나타내는 Session Log Event의 형식이 정해질 때 함께 정합니다([Domain Model](DOMAIN_MODEL.md#결정되지-않은-사항) 참고).
- Plugin 버전이 바뀌어, 이미 저장된 Turn과 같은 `user_message`로 시작하지만 구성이 다른 Turn이 왔을 때의 처리. 지금은 Session Log Event마다 중복을 판단하므로 새 `event_id`의 Session Log Event만 그 Turn에 더해집니다.
- Turn을 시작하는 `user_message`가 잘못되어 빠진 경우, 그 Turn의 나머지 Session Log Event의 소속 Turn
- `tool_use_id`가 고유한 범위. 지금은 Turn 안에서만 짝을 맞추므로 Turn 안에서 고유하면 됩니다.
- 저장한 데이터의 암호화와 접근 제어
