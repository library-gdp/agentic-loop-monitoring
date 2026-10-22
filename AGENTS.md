# AGENTS.md

## Project
AI 코딩 에이전트(Claude Code, Codex, OpenCode 등)의 작업을 수집, 저장, 시각화하는 모니터링 애플리케이션입니다.

## Intent
프로젝트의 목적과 기대 결과는 `intent/`에서 관리합니다. 기능의 범위나 우선순위를 판단해야 할 때 먼저 읽으세요.

| 문서 | 요약 |
|---|---|
| [INTENT-1.0.md](intent/INTENT-1.0.md) | 사람이 실패라고 판단한 에이전트 작업을 사후에 역추적해, 각 LLM Call의 모든 input과 output을 보고 잘못된 판단 지점과 토큰 낭비를 찾아 워크플로우와 하네스를 개선하게 합니다. |

## Documentation
설계 문서는 `docs/`에 있습니다. 작업을 시작하기 전에 아래 표에서 작업과 관련된 문서를 찾아 읽으세요. 모든 문서를 미리 읽을 필요는 없습니다.

| 문서 | 내용 | 이럴 때 읽기 |
|---|---|---|
| [System Architecture](docs/SYSTEM_ARCHITECTURE.md) | 시스템 구성(Hook Client, Client Adapter Daemon, Main Server), 데이터 흐름, 전달 보장, 원칙(Observe-only, Fail-open, Masking) | 프로세스 간 역할 분담이나 데이터 흐름을 확인할 때, Transport를 고를 때 |
| [Application Architecture](docs/APPLICATION_ARCHITECTURE.md) | Main Server의 모듈 구성(Core, Input Adapter, Persistence, Visualization)과 모듈 간 의존 관계 | Main Server의 모듈을 추가하거나 바꿀 때, 모듈 간 의존 관계를 확인할 때 |
| [Client Adapter Daemon](docs/CLIENT_ADAPTER_DAEMON.md) | Hook Client와 Signal, Daemon의 Signal 처리 순서, Ack 처리, Offset Store와 Offset 검증 | Daemon이나 Hook Client를 구현하거나 바꿀 때 |
| [Plugin Specification](docs/PLUGIN_SPEC.md) | Plugin 인터페이스(`resolve`, `read`), 에이전트 id, Plugin State, event id 규칙 | 새 에이전트를 지원하거나 Plugin을 구현할 때 |
| [Wire Protocol](docs/WIRE_PROTOCOL.md) | Batch, Wire Event, Ack의 형식, 버전 규칙, Transport별 바인딩 | Daemon과 Main Server 사이의 통신을 구현하거나 Wire Event를 바꿀 때 |
| [Glossary](docs/GLOSSARY.md) | 도메인 용어(Session, Turn, Loop, LLM Call, Tool Call 등)와 시스템 구성, 수집, 전송 관련 용어의 정의 | 도메인 모델이나 Canonical Event를 설계할 때, 문서나 코드에서 용어의 의미를 확인할 때 |

아키텍처 문서와 명세 문서(모듈별 API 명세, Canonical Event 모델, Wire Protocol 등)는 모두 이 표에 행으로 추가합니다.

### 문서 작성 규칙
- `docs/`에 문서를 추가, 삭제하거나 이름을 바꾸면 같은 커밋에서 이 섹션의 표도 갱신합니다.
- 파일 이름 규칙: ...
- 링크는 상대 경로로 작성합니다. 이 파일에서는 저장소 루트 기준(`docs/...`), `docs/` 안의 문서끼리는 서로의 위치 기준입니다.
