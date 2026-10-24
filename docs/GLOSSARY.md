# GLOSSARY.md

이 문서는 애플리케이션에서 사용하는 도메인 용어를 정의합니다. 다른 문서와 코드에서는 여기서 정의한 용어를 같은 의미로 사용합니다.

## 에이전트 활동

AI 에이전트의 작업을 나누는 단위입니다. 위에서 아래로 갈수록 작은 단위이며, 각 단위는 바로 위 단위에 속합니다.

```
Session
└── Turn
    └── Loop
        ├── LLM Call
        └── Tool Call ── (Subagent)
```

| 용어 | 정의 |
|---|---|
| Agentic Loop | AI 에이전트가 작업을 처리하는 방식입니다. LLM을 호출하고, LLM이 요청한 도구를 실행한 뒤 그 결과로 다시 LLM을 호출하는 과정을 작업이 끝날 때까지 반복합니다. |
| Session | 에이전트 프로세스 하나의 대화 단위입니다. 에이전트가 부여한 session id로 식별합니다. |
| Turn | 사용자 프롬프트 한 번부터 에이전트가 Stop할 때까지의 구간입니다. 하나의 Turn은 하나 이상의 Loop로 이루어집니다. |
| Loop | Turn 안에서 LLM Call 한 번과, 그 응답이 요청한 Tool Call들의 묶음입니다. Agentic Loop의 반복 한 번에 해당합니다. |
| LLM Call | 모델에 대한 요청과 응답 한 번입니다. input, output, reasoning, 토큰 사용량, 모델 이름, 소요 시간을 가집니다. input은 그 요청으로 모델에 들어간 모든 것입니다. 시스템 프롬프트, AGENTS.md(CLAUDE.md) 같은 지침 파일, Skill, 도구 정의, compaction 결과, Subagent에 넘긴 프롬프트, 사용자 메시지, 이전 모델 응답, 도구 결과를 포함합니다. |
| Tool Call | LLM Call이 요청한 도구 실행 한 번입니다. 도구 이름, 인자, 결과, 성공 여부, 소요 시간을 가집니다. 자신을 요청한 LLM Call과 연결됩니다. |
| Subagent | 에이전트가 작업 중에 띄운 하위 에이전트입니다. 자신을 띄운 Tool Call과 연결되며, 자체적인 Loop를 가집니다. |

## Metric

| 용어 | 정의 |
|---|---|
| Token Usage | LLM Call 한 번에 사용한 토큰 수입니다. 에이전트가 제공하는 범위 안에서 Input Token, Output Token, Cache Read Token, Cache Write Token, Reasoning Token으로 나누어 기록합니다. |
| Input Token | 모델에 입력으로 전달된 토큰입니다. Cache Read Token과 Cache Write Token은 포함하지 않습니다. |
| Output Token | 모델이 생성한 토큰입니다. |
| Cache Read Token | prompt cache에서 읽어 처리한 입력 토큰입니다. |
| Cache Write Token | prompt cache에 새로 기록한 입력 토큰입니다. |
| Reasoning Token | 모델이 응답 전에 추론 과정에서 생성한 토큰입니다. |
| Duration | 하나의 단위(LLM Call, Tool Call, Loop, Turn, Session)가 시작해서 끝날 때까지 걸린 시간입니다. |

## 시스템 구성

| 용어 | 정의 |
|---|---|
| Client Adapter Daemon | 에이전트가 실행되는 머신에서 상주하는 프로세스입니다. Plugin이 Session Log File을 읽어 만든 Session Log Event를 Main Server로 보냅니다. 줄여서 Daemon이라고 부릅니다. |
| Main Server | Client Adapter Daemon이 보낸 Session Log Event를 저장, 조회, 시각화하는 서버입니다. Input Adapter, Core, Persistence, Visualization 모듈로 이루어집니다. 같은 머신에서 실행될 수도 있고 원격에서 실행될 수도 있습니다. |
| Plugin | Client Adapter Daemon 안에 에이전트마다 하나씩 두는 구성 요소입니다. 해당 에이전트의 Session Log File을 언제(Trigger), 어떻게 읽을지 정의하고, 읽은 레코드를 Session Log Event로 변환합니다. |

## 수집

| 용어 | 정의 |
|---|---|
| Session Log File | 에이전트가 세션의 대화 내용과 LLM 호출 정보를 기록하는 파일입니다. 에이전트마다 위치와 형식, 파일 구성이 다릅니다. |
| Trigger | Plugin이 Session Log File 읽기를 시작하는 조건입니다. 에이전트마다 다르며 Plugin이 정의합니다. |

## 전송

| 용어 | 정의 |
|---|---|
| Agent Logging Protocol | Client Adapter Daemon과 Main Server가 주고받는 메시지의 형식과, Transport별로 메시지를 실어 나르는 방식입니다. |
| Session Log Event | Agent Logging Protocol이 정의하는, 에이전트 종류와 무관한 공통 포맷의 이벤트입니다. Plugin이 만들며, Main Server의 Core도 같은 모델을 씁니다. |
| Batch | Session Log Event를 묶어 한 번에 Main Server로 보내는 단위입니다. 한 Batch의 Session Log Event는 모두 한 Session의 끝난 Turn에서 나옵니다. |
| Ack | Main Server가 Batch를 처리한 결과로 돌려주는 응답입니다. |
| Transport | Client Adapter Daemon과 Main Server 사이에서 메시지를 주고받는 방식입니다. 표준입출력, Unix Socket, REST API, Streamable HTTP, WebSocket이 있습니다. |
| Decoder | Main Server의 Input Adapter에서 Session Log Event를 deserialization하는 부분입니다. |

## 모듈 API

| 용어 | 정의 |
|---|---|
| Ingest API | Input Adapter가 Session Log Event를 Core에 전달하기 위한 API입니다. |
| Query API | Visualization이 기록된 데이터를 조회하기 위한 API입니다. |
| Repository API | 데이터 영속화를 위한 API입니다. Core가 정의하고 Persistence가 구현합니다. |

시스템 구성과 데이터 흐름은 [System Architecture](SYSTEM_ARCHITECTURE.md)를, Main Server의 모듈 구성과 의존 관계는 [Application Architecture](APPLICATION_ARCHITECTURE.md)를 참고하세요.
