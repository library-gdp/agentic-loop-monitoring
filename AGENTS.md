# AGENTS.md

## Project
AI 코딩 에이전트(Claude Code, Codex, OpenCode 등)의 작업을 수집, 저장, 시각화하는 모니터링 애플리케이션입니다.

## Documentation
설계 문서는 `docs/`에 있습니다. 작업을 시작하기 전에 아래 표에서 작업과 관련된 문서를 찾아 읽으세요. 모든 문서를 미리 읽을 필요는 없습니다.

| 문서 | 내용 | 이럴 때 읽기 |
|---|---|---|
| [Application Architecture](docs/APPLICATION_ARCHITECTURE.md) | 모듈 구성(Core, Input Adapter, Persistence, Visualization)과 원칙(Observe-only, Fail-open, Masking) | 모듈을 추가하거나 바꿀 때, 모듈 간 의존 관계를 확인할 때 |
| [Glossary](docs/GLOSSARY.md) | 도메인 용어(Session, Turn, Loop, LLM Call, Tool Call 등)와 수집 관련 용어의 정의 | 도메인 모델이나 Canonical Event를 설계할 때, 문서나 코드에서 용어의 의미를 확인할 때 |

아키텍처 문서와 명세 문서(모듈별 API 명세, Canonical Event 모델, Wire Protocol 등)는 모두 이 표에 행으로 추가합니다.

### 문서 작성 규칙
- `docs/`에 문서를 추가, 삭제하거나 이름을 바꾸면 같은 커밋에서 이 섹션의 표도 갱신합니다.
- 파일 이름 규칙: ...
- 링크는 상대 경로로 작성합니다. 이 파일에서는 저장소 루트 기준(`docs/...`), `docs/` 안의 문서끼리는 서로의 위치 기준입니다.
