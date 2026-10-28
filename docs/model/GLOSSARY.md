# GLOSSARY.md

이 문서는 애플리케이션에서 사용하는 도메인 용어를 정의합니다. 다른 문서와 코드에서는 여기서 정의한 용어를 같은 의미로 사용합니다.

"에이전트"는 Claude Code, Codex, OpenCode 같은 AI 코딩 에이전트 자체를 가리키고, "Agent"는 Session 안에서 동작하는 Main Agent와 Subagent를 가리킵니다.

## 에이전트 활동

AI 에이전트의 작업을 나누는 단위입니다. 위에서 아래로 갈수록 작은 단위이며, 각 단위는 바로 위 단위에 속합니다.

```
Session
└── Agent (Main Agent, Subagent)
    └── Turn
        └── Loop
            ├── LLM Call
            └── Tool Call ── (Subagent)
```

| 용어 | 정의 |
|---|---|
| Agentic Loop | AI 에이전트가 작업을 처리하는 방식입니다. LLM을 호출하고, LLM이 요청한 도구를 실행한 뒤 그 결과로 다시 LLM을 호출하는 과정을 작업이 끝날 때까지 반복합니다. |
| Session | 사용자가 에이전트와 대화를 시작할 때 만들어지는 대화 단위입니다. Session ID로 식별합니다. 그 대화의 Main Agent와 Subagent가 모두 한 Session에 속하며 같은 Session ID를 공유합니다. |
| Agent | Session 안에서 Agentic Loop를 수행하는 주체입니다. Main Agent와 Subagent 두 종류가 있습니다. 모든 Agent는 Session ID, Agent ID, 부모 Agent ID를 가집니다. |
| Main Agent | 사용자와 직접 대화하는 Agent입니다. Session마다 하나이며, 부모 Agent가 없으므로 부모 Agent ID는 NULL입니다. |
| Turn | Agent가 프롬프트 한 번을 받은 때부터 Stop할 때까지의 구간입니다. Main Agent의 프롬프트는 사용자가 입력하고, Subagent의 프롬프트는 부모 Agent가 넘깁니다. 하나의 Turn은 하나 이상의 Loop로 이루어집니다. |
| Loop | Turn 안에서 LLM Call 한 번과, 그 응답이 요청한 Tool Call들의 묶음입니다. Agentic Loop의 반복 한 번에 해당합니다. |
| LLM Call | 모델에 대한 요청과 응답 한 번입니다. input, output, reasoning, 토큰 사용량, 모델 이름, 소요 시간을 가집니다. input은 그 요청으로 모델에 들어간 모든 것입니다. 시스템 프롬프트, AGENTS.md(CLAUDE.md) 같은 지침 파일, Skill, 도구 정의, compaction 결과, Subagent에 넘긴 프롬프트, 사용자 메시지, 이전 모델 응답, 도구 결과를 포함합니다. |
| Tool Call | LLM Call이 요청한 도구 실행 한 번입니다. 도구 이름, 인자, 결과, 성공 여부, 소요 시간을 가집니다. 자신을 요청한 LLM Call과 연결됩니다. |
| Subagent | Agent가 작업 중에 Tool Call로 띄운 하위 Agent입니다. 자신을 띄운 Agent가 부모 Agent이며, Subagent가 띄운 Agent도 Subagent입니다. 자신을 띄운 Tool Call과 연결되며, 부모 Agent와 따로 자체적인 Turn과 Loop를 가집니다. |

## 식별자

| 용어 | 정의 |
|---|---|
| Session ID | Session을 식별하는 id입니다. 사용자가 에이전트와 대화를 처음 시작할 때 에이전트가 만들며, Main Agent와 Subagent가 모두 같은 값을 공유합니다. |
| Agent ID | Session 안에서 Agent를 식별하는 id입니다. 에이전트가 부여하며, 어떤 값을 쓰는지는 에이전트마다 다릅니다. 예를 들어 Main Agent의 Agent ID로 Session ID를 그대로 쓰는 에이전트도 있습니다. [Plugin Specification](PLUGIN_SPEC.md#에이전트-id)의 에이전트 id(`claude-code`처럼 에이전트 종류를 나타내는 값)와는 다릅니다. |
| 부모 Agent ID | Agent를 띄운 부모 Agent의 Agent ID입니다. Main Agent는 부모 Agent가 없으므로 NULL입니다. |

## Metric

| 용어 | 정의 |
|---|---|
| Token Usage | LLM Call 한 번에 사용한 토큰 수입니다. 에이전트가 제공하는 범위 안에서 Input Token, Output Token, Cache Read Token, Cache Write Token, Reasoning Token으로 나누어 기록합니다. |
| Input Token | 모델에 입력으로 전달된 토큰입니다. Cache Read Token과 Cache Write Token은 포함하지 않습니다. |
| Output Token | 모델이 생성한 토큰입니다. |
| Cache Read Token | prompt cache에서 읽어 처리한 입력 토큰입니다. |
| Cache Write Token | prompt cache에 새로 기록한 입력 토큰입니다. |
| Reasoning Token | 모델이 응답 전에 추론 과정에서 생성한 토큰입니다. |
| Duration | 하나의 단위(LLM Call, Tool Call, Loop, Turn, Agent, Session)가 시작해서 끝날 때까지 걸린 시간입니다. |

## 시스템 구성

| 용어 | 정의 |
|---|---|
| Client Adapter Daemon | 에이전트가 실행되는 머신에서 상주하는 프로세스입니다. Plugin이 Session Log를 수집해 만든 Session Log Event를 Main Server로 보냅니다. 줄여서 Daemon이라고 부릅니다. |
| Main Server | Client Adapter Daemon이 보낸 Session Log Event를 저장, 조회, 시각화하는 서버입니다. Input Adapter, Core, Persistence, Visualization 모듈로 이루어집니다. 같은 머신에서 실행될 수도 있고 원격에서 실행될 수도 있습니다. |
| Plugin | Client Adapter Daemon 안에 에이전트마다 하나씩 두는 구성 요소입니다. 해당 에이전트의 Session Log를 언제(Trigger), 어떻게 수집할지 정의하고, 수집한 레코드를 Session Log Event로 변환해 Batch 단위로 묶습니다. |

## 수집

| 용어 | 정의 |
|---|---|
| Session Log | 에이전트가 Session의 대화 내용과 LLM 호출 정보를 기록한 것입니다. 레코드로 이루어지며, 어디에 어떤 형식으로 기록하는지는 에이전트마다 다릅니다. |
| Session Log 수집 | Plugin이 에이전트의 Session Log를 가져오는 일입니다. 언제 수집할지(Trigger)와 어떻게 수집할지(수집 방식)는 에이전트마다 다르며 Plugin이 정의합니다. |
| Trigger | Plugin이 Session Log 수집을 시작하는 조건입니다. 에이전트마다 다르며 Plugin이 정의합니다. |

## 전송

| 용어 | 정의 |
|---|---|
| Agent Logging Protocol | Client Adapter Daemon과 Main Server가 주고받는 메시지의 형식과, Transport별로 메시지를 실어 나르는 방식입니다. |
| Session Log Event | 에이전트 종류와 무관한 공통 포맷의 이벤트입니다. 필드는 [Domain Model](DOMAIN_MODEL.md#session-log-event)에서 정의합니다. Plugin이 만들며, Main Server의 Core도 같은 모델을 씁니다. |
| Batch | Session Log Event를 묶어 한 번에 Main Server로 보내는 단위입니다. 어떻게 묶을지는 Plugin이 정의합니다. 한 Batch의 Session Log Event는 모두 한 Session, 한 Agent의 끝난 Turn에서 나옵니다. |
| Ack | Main Server가 Batch를 처리한 결과로 돌려주는 응답입니다. |
| Transport | Client Adapter Daemon과 Main Server 사이에서 메시지를 주고받는 방식입니다. |
| Decoder | Main Server의 Input Adapter에서 Session Log Event를 deserialization하는 부분입니다. |

## 데이터

| 용어 | 정의 |
|---|---|
| 원본 데이터 | Main Server가 Batch로 받아 저장하고 다른 데이터로 다시 계산할 수 없는 데이터입니다. Session, Agent, Session Log Event, 수신 기록이 있습니다. 추가만 하고 고치지 않습니다. |
| 파생 데이터 | Core가 원본 데이터로 계산해 저장하는 활동 모델의 색인입니다. 언제든 버리고 다시 만들 수 있습니다. |
| 수신 기록 | Main Server가 받은 Batch마다 남기는 기록입니다. `batch_id`, `protocol_version`, `source.plugin_version`, 받은 시각 등을 가집니다. |

자세한 내용은 [Data Architecture](DATA_ARCHITECTURE.md)를 참고하세요.

## 모듈 API

| 용어 | 정의 |
|---|---|
| Ingest API | Input Adapter가 Session Log Event를 Core에 전달하기 위한 API입니다. |
| Query API | Visualization이 기록된 데이터를 조회하기 위한 API입니다. |
| Repository API | 데이터 영속화를 위한 API입니다. Core가 정의하고 Persistence가 구현합니다. |

시스템 구성과 데이터 흐름은 [System Architecture](SYSTEM_ARCHITECTURE.md)를, Main Server의 모듈 구성과 의존 관계는 [Application Architecture](APPLICATION_ARCHITECTURE.md)를 참고하세요.
