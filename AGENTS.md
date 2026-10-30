# AGENTS.md

## Project
AI 코딩 에이전트(Claude Code, Codex, OpenCode 등)의 작업을 수집, 저장, 시각화하는 모니터링 애플리케이션입니다.

## Intent
프로젝트의 목적과 기대 결과는 `intent/`에서 관리합니다. 기능의 범위나 우선순위를 판단해야 할 때 먼저 읽으세요.

| 문서 | 요약 |
|---|---|
| [INTENT-1.0.md](intent/INTENT-1.0.md) | 사람이 실패라고 판단한 에이전트 작업을 사후에 역추적해, 각 LLM Call의 모든 input과 output을 보고 잘못된 판단 지점과 토큰 낭비를 찾아 워크플로우와 하네스를 개선하게 합니다. |

## Documentation
설계 문서는 `docs/`에 있으며, 구현에 의존하지 않는 `docs/001.model/`과 구체적인 구현 방안을 다루는 `docs/002.implementation/`으로 나뉩니다. 두 디렉터리의 구분은 [docs/AGENTS.md](docs/AGENTS.md)를 참고하세요. 작업을 시작하기 전에 아래 표에서 작업과 관련된 문서를 찾아 읽으세요. 모든 문서를 미리 읽을 필요는 없습니다.

| 문서 | 내용 | 이럴 때 읽기 |
|---|---|---|
| [System Architecture](docs/001.model/001.SYSTEM_ARCHITECTURE.md) | 시스템 구성(Client Adapter Daemon, Main Server), 데이터 흐름, 전달 보장, 원칙(Observe-only, Fail-open, Masking) | 프로세스 간 역할 분담이나 데이터 흐름을 확인할 때 |
| [Glossary](docs/001.model/002.GLOSSARY.md) | 도메인 용어(Session, Main Agent, Subagent, Turn, Loop, LLM Call, Tool Call 등), Session ID와 Agent ID 같은 식별자, 시스템 구성, 수집, 전송, 데이터(원본 데이터, 파생 데이터, 수신 기록) 관련 용어의 정의 | 도메인 모델이나 Session Log Event를 설계할 때, 문서나 코드에서 용어의 의미를 확인할 때 |
| [Domain Model](docs/001.model/003.DOMAIN_MODEL.md) | Session Log Event, Token Usage와 Core가 구성하는 Session, Agent(Main Agent, Subagent), Turn, Loop, LLM Call, Tool Call, Compaction의 필드, Agent와 Turn 구성 규칙 | Session Log Event를 만들거나 바꿀 때, Core의 엔티티나 저장 구조를 설계할 때 |
| [Agent Logging Protocol](docs/001.model/004.AGENT_LOGGING_PROTOCOL.md) | Transport Unit, Ack의 형식, 버전 규칙, Transport가 지켜야 하는 규칙 | Daemon과 Main Server 사이의 통신을 설계하거나 구현할 때 |
| [Plugin Specification](docs/001.model/005.PLUGIN_SPEC.md) | Plugin이 정의하는 Trigger, 수집 방식과 지켜야 하는 규칙, Session ID와 Agent ID 규칙, Turn 단위, 레코드 하나마다 넘기는 Transport Unit의 규칙, 에이전트 id, event id 규칙, 에이전트별 문서에 적을 내용 | 새 에이전트를 지원하거나 Plugin을 구현할 때, 에이전트별 Plugin 문서를 쓸 때 |
| [Client Adapter Daemon](docs/001.model/006.CLIENT_ADAPTER_DAEMON.md) | Daemon의 구성 요소, Transport Unit 전송, Ack 처리, 설정 | Daemon을 구현하거나 바꿀 때 |
| [Application Architecture](docs/001.model/007.APPLICATION_ARCHITECTURE.md) | Main Server의 모듈 구성(Core, Input Adapter, Persistence, Visualization)과 모듈 간 의존 관계 | Main Server의 모듈을 추가하거나 바꿀 때, 모듈 간 의존 관계를 확인할 때 |
| [Data Architecture](docs/001.model/008.DATA_ARCHITECTURE.md) | 데이터가 있는 곳과 소유자, Main Server가 저장하는 Entity(원본 데이터: Session, Agent, Session Log Event, 수신 기록 / 파생 데이터: Turn, LLM Call, Tool Call, Compaction)의 목록과 필드, 관계, 원자적 쓰기, 질의, Session 단위 삭제, 형식 변경 처리 | Persistence나 Ingest API, Query API를 설계하거나 구현할 때, 무엇을 저장하고 무엇을 계산할지 정할 때 |
| [Tech Stack](docs/002.implementation/001.TECH_STACK.md) | 구현 언어(모두 TypeScript), 런타임(Bun), 프레임워크(Hono), Daemon과 Main Server를 한 프로세스로 구동하는 실행 구성, 저장소(SQLite), 그 이유 | 코드를 작성하기 전에 구현 언어와 런타임, 실행 구성을 확인할 때 |
| [Message Convention](docs/002.implementation/002.MESSAGE_CONVENTION.md) | Agent Logging Protocol 메시지 규약(UTF-8 JSON, 시각 형식)과 Transport Unit, Ack 예시 | 메시지를 직렬화하거나 해석할 때 |
| [Transport](docs/002.implementation/003.TRANSPORT.md) | Transport(프로세스 내 호출, 표준입출력, Unix Socket, REST API, Streamable HTTP, WebSocket)별 바인딩 | Transport를 고르거나 구현할 때, Daemon의 Transport Client나 Main Server의 Input Adapter를 구현할 때 |
| [Plugin Guide](docs/002.implementation/004.PLUGIN_GUIDE.md) | Plugin을 Daemon과 따로 빌드하고 Daemon이 시작할 때 불러와 Plugin Collection에 등록하는 방식(패키지 구성, 빌드한 Plugin, 불러오기, 등록, 고르기 절차, Plugin 추가하기), Session Log를 파일로 수집하는 경우의 지침, Plugin 구현에 관한 결정되지 않은 사항 | Plugin 코드를 작성하거나 Daemon에 추가할 때 |
| [Plugin Interface](docs/002.implementation/005.PLUGIN_INTERFACE.md) | Plugin이 구현하는 TypeScript 인터페이스(`PluginModule`, `PluginRegistry`, `Plugin`, `PluginContext`, `PluginTransportUnit`), Plugin API 버전, 시작과 종료, Transport Unit 넘기기와 로그, Session Log Event 타입 | Plugin이나 Daemon 코드에서 둘 사이의 인터페이스를 구현하거나 바꿀 때 |
| [Claude Code Plugin](docs/002.implementation/006.plugin/001.CLAUDE_CODE.md) | Claude Code Plugin 구현 방안. Main Agent와 Subagent의 Session ID, Agent ID, 부모 Agent ID를 Session Log에서 알아내는 방법 | Claude Code Plugin을 구현하거나 바꿀 때 |
| [Codex Plugin](docs/002.implementation/006.plugin/002.CODEX.md) | Codex Plugin 구현 방안. thread_id로 Session ID, Agent ID, 부모 Agent ID를 알아내는 방법 | Codex Plugin을 구현하거나 바꿀 때 |
| [OpenCode Plugin](docs/002.implementation/006.plugin/003.OPENCODE.md) | OpenCode Plugin 구현 방안. session id와 `parentID`로 Session ID, Agent ID, 부모 Agent ID를 알아내는 방법 | OpenCode Plugin을 구현하거나 바꿀 때 |
| [Client Adapter Daemon 구현](docs/002.implementation/007.CLIENT_ADAPTER_DAEMON.md) | Daemon의 실행 방식, 상태 디렉터리 등 구현 설정 | Daemon 코드를 작성, 빌드, 배포할 때 |
| [Data Storage](docs/002.implementation/008.DATA_STORAGE.md) | Main Server 데이터의 SQLite 설정과 라이브러리(`bun:sqlite`), Transport Unit 트랜잭션, LLM Call input 질의, 스키마 버전, Session 삭제 | Persistence를 구현할 때, 저장소 설정이나 쓰기, 읽기 절차를 바꿀 때 |
| [Table Definition](docs/002.implementation/009.TABLE_DEFINITION.md) | Main Server SQLite 테이블 정의서: 테이블 목록, 관계와 외래 키, 테이블별 열(타입, NULL, 키, Entity 필드 대응), 제약 조건, 인덱스, DDL | 테이블을 만들거나 바꿀 때, 질의를 작성할 때 |

아키텍처 문서와 명세 문서(모듈별 API 명세, Domain Model, Agent Logging Protocol 등)는 모두 이 표에 행으로 추가합니다.

### 문서 작성 규칙
- `docs/`에 문서를 추가, 삭제하거나 이름을 바꾸면 같은 커밋에서 이 섹션의 표도 갱신합니다.
- 파일 이름 규칙: `docs/` 아래의 문서와 디렉터리 이름은 아래의 [문서 넘버링 규칙](#문서-넘버링-규칙)을 따릅니다.
- 링크는 상대 경로로 작성합니다. 이 파일에서는 저장소 루트 기준(`docs/...`), `docs/` 안의 문서끼리는 서로의 위치 기준입니다.

### 문서 넘버링 규칙
`docs/`의 문서는 디렉터리 구조로 계층을 이룹니다. 각 디렉터리를 node라고 부릅니다. 각 node는 바로 아래의 파일과 디렉터리에 읽는 순서대로 번호를 붙입니다. 순서는 프로젝트를 처음 읽는 사람이 자연스럽게 읽을 수 있도록 정합니다.

```
docs/
  001.model/
    001.SYSTEM_ARCHITECTURE.md
    002.GLOSSARY.md
    ...
  002.implementation/
    001.TECH_STACK.md
    ...
    005.PLUGIN_INTERFACE.md
    006.plugin/
      001.CLAUDE_CODE.md
      002.CODEX.md
      003.OPENCODE.md
    007.CLIENT_ADAPTER_DAEMON.md
    ...
```

- 이름은 `<세 자리 번호>.<이름>` 형식입니다. 파일과 디렉터리 모두 번호를 붙입니다.
- 번호는 node마다 `001`부터 따로 시작합니다. 파일과 디렉터리는 한 순서 안에 섞여 있을 수 있고, 다른 node와 번호가 이어지지 않습니다.
- 새 문서나 디렉터리는 읽는 순서에 맞는 자리에 넣습니다. 순서 중간에 넣어도 되며, 그때는 같은 node에서 그보다 뒤에 오는 항목의 번호를 1씩 뒤로 밉니다. 다른 node의 번호는 바꾸지 않습니다.
- 번호가 바뀌면 같은 커밋에서 그 문서와 그 아래 문서를 가리키는 링크(`docs/`, `adr/`, `intent/`, 이 파일)와 해당 문서의 제목을 함께 고칩니다.
- 문서의 제목(H1)은 파일 이름과 같게 둡니다(예: `# 001.SYSTEM_ARCHITECTURE.md`).
- 위 [Documentation](#documentation) 표의 행은 위 트리를 위에서 아래로 읽은 순서로 둡니다.
- `AGENTS.md`와 `CLAUDE.md`는 도구가 정확한 이름으로 찾는 파일이므로 번호를 붙이지 않습니다.
