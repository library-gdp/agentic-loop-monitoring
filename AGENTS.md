# AGENTS.md

## Project
AI 코딩 에이전트(Claude Code, Codex, OpenCode 등)의 작업을 수집, 저장, 시각화하는 모니터링 애플리케이션입니다.

## Intent
프로젝트의 목적과 기대 결과는 `intent/`에서 관리합니다. 기능의 범위나 우선순위를 판단해야 할 때 먼저 읽으세요.

| 문서 | 요약 |
|---|---|
| [INTENT-1.0.md](intent/INTENT-1.0.md) | 사람이 실패라고 판단한 에이전트 작업을 사후에 역추적해, 각 LLM Call의 모든 input과 output을 보고 잘못된 판단 지점과 토큰 낭비를 찾아 워크플로우와 하네스를 개선하게 합니다. |

## Documentation
설계 문서는 `docs/`에 있으며, 구현에 의존하지 않는 `docs/model/`과 구체적인 구현 방안을 다루는 `docs/implementation/`으로 나뉩니다. 두 디렉터리의 구분은 [docs/AGENTS.md](docs/AGENTS.md)를 참고하세요. 작업을 시작하기 전에 아래 표에서 작업과 관련된 문서를 찾아 읽으세요. 모든 문서를 미리 읽을 필요는 없습니다.

| 문서 | 내용 | 이럴 때 읽기 |
|---|---|---|
| [System Architecture](docs/model/SYSTEM_ARCHITECTURE.md) | 시스템 구성(Client Adapter Daemon, Main Server), 데이터 흐름, 전달 보장, 원칙(Observe-only, Fail-open, Masking) | 프로세스 간 역할 분담이나 데이터 흐름을 확인할 때 |
| [Application Architecture](docs/model/APPLICATION_ARCHITECTURE.md) | Main Server의 모듈 구성(Core, Input Adapter, Persistence, Visualization)과 모듈 간 의존 관계 | Main Server의 모듈을 추가하거나 바꿀 때, 모듈 간 의존 관계를 확인할 때 |
| [Client Adapter Daemon](docs/model/CLIENT_ADAPTER_DAEMON.md) | Daemon의 구성 요소, Batch 전송, Ack 처리, 설정 | Daemon을 구현하거나 바꿀 때 |
| [Plugin Specification](docs/model/PLUGIN_SPEC.md) | Plugin이 정의하는 Trigger, 수집 방식, Batch 단위와 지켜야 하는 규칙, Session ID와 Agent ID 규칙, Turn 단위, 에이전트 id, event id 규칙, 에이전트별 문서에 적을 내용 | 새 에이전트를 지원하거나 Plugin을 구현할 때, 에이전트별 Plugin 문서를 쓸 때 |
| [Agent Logging Protocol](docs/model/AGENT_LOGGING_PROTOCOL.md) | Batch, Ack의 형식, 버전 규칙, Transport가 지켜야 하는 규칙 | Daemon과 Main Server 사이의 통신을 설계하거나 구현할 때 |
| [Domain Model](docs/model/DOMAIN_MODEL.md) | Session Log Event, Token Usage와 Core가 구성하는 Session, Agent(Main Agent, Subagent), Turn, Loop, LLM Call, Tool Call의 필드, Agent와 Turn 구성 규칙 | Session Log Event를 만들거나 바꿀 때, Core의 엔티티나 저장 구조를 설계할 때 |
| [Glossary](docs/model/GLOSSARY.md) | 도메인 용어(Session, Main Agent, Subagent, Turn, Loop, LLM Call, Tool Call 등), Session ID와 Agent ID 같은 식별자, 시스템 구성, 수집, 전송 관련 용어의 정의 | 도메인 모델이나 Session Log Event를 설계할 때, 문서나 코드에서 용어의 의미를 확인할 때 |
| [Tech Stack](docs/implementation/TECH_STACK.md) | 구성 요소별 구현 언어(Client Adapter Daemon과 Plugin은 TypeScript, Main Server는 Kotlin)와 그 이유 | 코드를 작성하기 전에 구현 언어를 확인할 때 |
| [Client Adapter Daemon 구현](docs/implementation/CLIENT_ADAPTER_DAEMON.md) | Daemon의 실행 방식, 상태 디렉터리 등 구현 설정 | Daemon 코드를 작성, 빌드, 배포할 때 |
| [Plugin Guide](docs/implementation/PLUGIN_GUIDE.md) | Plugin을 Daemon 실행 파일에 함께 빌드하는 방식, Session Log를 파일로 수집하는 경우의 지침, Plugin 구현에 관한 결정되지 않은 사항 | Plugin 코드를 작성하거나 Daemon에 추가할 때 |
| [Claude Code Plugin](docs/implementation/plugin/CLAUDE_CODE.md) | Claude Code Plugin 구현 방안. Main Agent와 Subagent의 Session ID, Agent ID, 부모 Agent ID를 Session Log에서 알아내는 방법 | Claude Code Plugin을 구현하거나 바꿀 때 |
| [Codex Plugin](docs/implementation/plugin/CODEX.md) | Codex Plugin 구현 방안. thread_id로 Session ID, Agent ID, 부모 Agent ID를 알아내는 방법 | Codex Plugin을 구현하거나 바꿀 때 |
| [OpenCode Plugin](docs/implementation/plugin/OPENCODE.md) | OpenCode Plugin 구현 방안. session id와 `parentID`로 Session ID, Agent ID, 부모 Agent ID를 알아내는 방법 | OpenCode Plugin을 구현하거나 바꿀 때 |
| [Message Convention](docs/implementation/MESSAGE_CONVENTION.md) | Agent Logging Protocol 메시지 규약(UTF-8 JSON, 시각 형식)과 Batch, Ack 예시 | 메시지를 직렬화하거나 해석할 때 |
| [Transport](docs/implementation/TRANSPORT.md) | Transport(표준입출력, Unix Socket, REST API, Streamable HTTP, WebSocket)별 바인딩 | Transport를 고르거나 구현할 때, Daemon의 Transport Client나 Main Server의 Input Adapter를 구현할 때 |

아키텍처 문서와 명세 문서(모듈별 API 명세, Domain Model, Agent Logging Protocol 등)는 모두 이 표에 행으로 추가합니다.

### 문서 작성 규칙
- `docs/`에 문서를 추가, 삭제하거나 이름을 바꾸면 같은 커밋에서 이 섹션의 표도 갱신합니다.
- 파일 이름 규칙: ...
- 링크는 상대 경로로 작성합니다. 이 파일에서는 저장소 루트 기준(`docs/...`), `docs/` 안의 문서끼리는 서로의 위치 기준입니다.
