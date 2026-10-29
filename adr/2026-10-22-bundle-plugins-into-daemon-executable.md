---
status: superseded
date: 2026-10-22
decision-makers: pgd
---

# Bundle Plugins into the Client Adapter Daemon executable

## Context and Problem Statement

Client Adapter Daemon은 에이전트마다 하나씩 있는 Plugin으로 Session Log File을 읽고 Session Log Event로 변환합니다([Plugin Specification](../docs/model/PLUGIN_SPEC.md)). [Split the system into a Client Adapter Daemon and a Main Server](2026-10-19-split-system-into-client-adapter-daemon-and-main-server.md)는 Plugin을 Daemon에 넣는 방식(빌드할 때 포함 또는 실행 중 로딩)을 범위 밖으로 남겼습니다. 구현을 시작하려면 이 방식을 정해야 합니다.

## Decision

Plugin 코드를 Daemon 실행 파일에 함께 빌드합니다.

- Daemon 실행 파일 하나에 지원하는 모든 에이전트의 Plugin이 들어 있습니다.
- Daemon은 실행 중에 Plugin을 불러오지 않습니다. 외부 라이브러리 파일, 스크립트, 별도 프로세스로 Plugin을 실행하지 않습니다.
- Daemon 설정의 "사용할 Plugin"은 실행 파일에 들어 있는 Plugin 가운데 활성화할 것을 고릅니다.
- 새 에이전트를 지원하거나 Plugin을 고치면 Daemon을 다시 빌드하고 배포합니다.

**범위 밖**

- 구현 언어, 그리고 그 언어에서 Plugin을 등록하는 구체적인 방법(모듈 구성, 등록 목록 등)
- `plugin_version`을 Plugin마다 따로 관리할지, Daemon 버전을 그대로 쓸지

## Consequences

- Good, because 에이전트 머신에 배포할 것이 실행 파일 하나뿐입니다. Plugin 파일의 위치나 호환성을 따로 관리하지 않습니다.
- Good, because Daemon과 Plugin의 인터페이스가 빌드할 때 맞춰집니다. 실행 중에 버전이 맞지 않는 Plugin을 불러오는 일이 없습니다.
- Good, because 외부 코드를 실행 중에 불러오지 않으므로 Session Log File 원문을 다루는 프로세스에 검증되지 않은 코드가 끼어들지 않습니다.
- Bad, because Plugin 하나만 고쳐도 Daemon 전체를 다시 빌드하고 각 에이전트 머신에 다시 배포해야 합니다.
- Bad, because Daemon 소스를 빌드하지 않고는 새 에이전트용 Plugin을 추가할 수 없습니다. 사용 범위를 팀이나 오픈소스로 넓히면 제약이 될 수 있습니다.

## Implementation Plan

- **Affected paths**: 아직 코드가 없습니다. 설계 문서는 다음과 같습니다.
  - [`docs/implementation/PLUGIN_GUIDE.md`](../docs/implementation/PLUGIN_GUIDE.md): Plugin을 Daemon에 넣는 방식
- **Dependencies**: 없음
- **Patterns to follow**:
  - Plugin은 Daemon 소스 안에서 에이전트마다 분리된 모듈로 두고, [Plugin Specification](../docs/model/PLUGIN_SPEC.md)의 인터페이스로만 Daemon과 연결합니다.
  - Daemon은 에이전트 id로 Plugin을 찾는 등록 목록 하나만 둡니다.
- **Patterns to avoid**:
  - 동적 라이브러리 로딩, 스크립트 실행, 하위 프로세스로 Plugin을 실행하지 않습니다.
  - Daemon 코드에서 Plugin 인터페이스를 거치지 않고 특정 Plugin의 내부를 직접 부르지 않습니다.

### Verification

- [ ] Daemon 배포물이 실행 파일 하나이며, Plugin을 위한 별도 파일이 없습니다.
- [ ] Daemon 소스에 동적 라이브러리 로딩이나 Plugin용 하위 프로세스 실행 코드가 없습니다.
- [ ] 설정에서 활성화하지 않은 Plugin은 시작하지 않으며, Session Log File을 읽지 않습니다.

## Alternatives Considered

- **실행 중 로딩(동적 라이브러리 또는 스크립트)**: Daemon을 다시 빌드하지 않고 Plugin을 추가하거나 고칠 수 있습니다. 하지만 Plugin 파일의 배포와 버전 호환성을 따로 관리해야 하고, 지원하는 에이전트가 세 개뿐인 지금은 그 비용이 이득보다 크므로 기각했습니다.
- **Plugin을 별도 프로세스로 실행**: Plugin을 아무 언어로나 쓸 수 있고 Daemon과 격리됩니다. 하지만 프로세스 사이의 통신 규약이 하나 더 생기고 Plugin마다 프로세스를 다루는 비용이 들어 기각했습니다.

## More Information

- 관련 ADR: [Split the system into a Client Adapter Daemon and a Main Server](2026-10-19-split-system-into-client-adapter-daemon-and-main-server.md)
- 대체한 ADR: [Load built Plugins into the Daemon at runtime](2026-10-29-load-built-plugins-into-daemon-at-runtime.md). Plugin을 Daemon과 따로 빌드하고, Daemon이 실행 중에 불러옵니다.
- 다시 검토할 조건: Daemon 소스를 빌드하지 않는 사람이 Plugin을 추가해야 하는 경우(예: 오픈소스로 공개해 외부 기여를 받는 경우)
