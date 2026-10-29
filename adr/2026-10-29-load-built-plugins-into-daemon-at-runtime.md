---
status: proposed
date: 2026-10-29
decision-makers: pgd
---

# Load built Plugins into the Daemon at runtime

## Context and Problem Statement

[Bundle Plugins into the Client Adapter Daemon executable](2026-10-22-bundle-plugins-into-daemon-executable.md)은 Plugin을 Daemon 실행 파일에 함께 빌드하기로 했습니다. 그래서 Daemon 소스가 모든 Plugin을 알고 있어야 하고, Plugin 하나를 추가하거나 고쳐도 Daemon 전체를 다시 빌드하고 배포해야 합니다.

Plugin 구조의 유연성을 얻으려면 Daemon이 Plugin의 존재를 모른 채 동작해야 합니다. Daemon은 Plugin API만 알고, 따로 빌드한 Plugin을 실행 중에 Daemon에 넣을 수 있어야 하며, 특정 에이전트의 Session Log를 수집할 때 그 에이전트에 맞는 Plugin을 불러와 써야 합니다.

## Decision

Plugin을 Daemon과 따로 빌드하고, Daemon은 빌드한 Plugin을 실행 중에 불러옵니다.

- **Daemon은 Plugin을 모릅니다.** Daemon 소스와 실행 파일에는 Plugin 코드도, Plugin 목록도 없습니다. Daemon과 Plugin은 Plugin API 패키지에만 의존합니다.
- **빌드한 Plugin**: 에이전트 id를 이름으로 하는 디렉터리 하나입니다. manifest(`plugin.json`)와 ES 모듈 하나로 번들한 진입점 모듈을 둡니다. manifest에는 에이전트 id, Plugin 버전, Plugin API 버전, 진입점 경로를 적습니다.
- **불러오기**: Daemon은 시작할 때 설정의 "사용할 Plugin"에 있는 에이전트 id마다 Plugin 디렉터리에서 그 이름의 디렉터리를 찾아 manifest를 읽고, Plugin API 버전이 맞으면 진입점 모듈을 동적 `import()`로 불러와 `start`를 부릅니다. 실패하면 로그를 남기고 그 Plugin만 건너뜁니다.
- **불러오는 시점**: Trigger는 Plugin이 정하므로 Daemon은 어느 에이전트의 Session Log를 언제 수집할지 모릅니다. 그래서 수집할 때가 아니라 Daemon이 시작할 때 불러옵니다. Plugin을 추가하거나 바꾸면 Daemon을 다시 시작합니다.
- **Plugin API 버전**: Plugin API 패키지가 `PLUGIN_API_VERSION`을 내보냅니다. Daemon은 manifest의 `api_version`이 자신이 빌드에 쓴 값과 같은 Plugin만 불러옵니다. 호환되지 않는 변경이 있을 때만 올립니다.
- **인터페이스**: [Plugin Interface](../docs/implementation/PLUGIN_INTERFACE.md)를 따릅니다. Plugin은 `start(context)`와 `stop()`을 구현하고, `context.submit(batch)`로 Batch를 넘기며, `context.logger`로 Daemon의 로그 파일에 기록합니다. `submit`은 전송 결과를 돌려주지 않습니다.

**범위 밖**

- 패키지 이름, 저장소 구성, 패키지 관리 도구와 번들 도구
- 빌드한 Plugin을 에이전트 머신에 배포하는 방법
- Plugin을 믿을 수 있는지 확인하는 방법(예: 서명 검증)
- Daemon을 다시 시작하지 않고 Plugin을 추가하거나 바꾸는 방법
- Plugin이 자신의 상태를 저장하는 위치
- TypeScript를 실행할 런타임과 Daemon을 실행 파일 하나로 빌드하는 방법

## Consequences

- Good, because Daemon을 다시 빌드하지 않고 Plugin을 추가하거나 고칠 수 있습니다. Daemon 소스를 빌드하지 않는 사람도 Plugin API만으로 새 에이전트용 Plugin을 만들 수 있습니다.
- Good, because Plugin마다 버전이 있어 Main Server의 수신 기록에서 어느 Plugin 버전이 만든 Session Log Event인지 알 수 있습니다.
- Good, because Daemon은 manifest만 읽고 불러올 Plugin을 고르므로, 활성화하지 않은 Plugin의 코드는 실행되지 않습니다.
- Bad, because Daemon 실행 파일 말고도 Plugin 디렉터리를 배포하고 관리해야 합니다.
- Bad, because Daemon과 Plugin의 호환성이 빌드할 때가 아니라 불러올 때 드러납니다. `api_version`이 맞지 않는 Plugin은 불러오지 않으므로 Plugin API 버전을 올리면 모든 Plugin을 다시 빌드해야 합니다.
- Bad, because Daemon은 Plugin 디렉터리의 코드를 사용자 권한으로 실행합니다. 그 디렉터리에 쓸 수 있는 사람은 Session Log 원문을 다루는 프로세스에 코드를 넣을 수 있습니다.
- Bad, because Plugin이 Daemon과 같은 프로세스에서 실행되므로, Plugin의 처리하지 않은 오류가 Daemon 전체를 멈출 수 있습니다.
- Bad, because Daemon의 런타임과 빌드 방법은 실행 파일 밖의 ES 모듈을 동적 `import()`로 불러올 수 있는 것으로 골라야 합니다.

## Implementation Plan

- **Affected paths**: 아직 코드가 없습니다. 설계 문서는 다음과 같습니다.
  - [`docs/implementation/PLUGIN_INTERFACE.md`](../docs/implementation/PLUGIN_INTERFACE.md): manifest, Plugin API 버전, Plugin 인터페이스
  - [`docs/implementation/PLUGIN_GUIDE.md`](../docs/implementation/PLUGIN_GUIDE.md): 패키지 구성, 빌드한 Plugin, Daemon이 Plugin을 불러오는 방식, Plugin 추가하기
  - [`docs/implementation/CLIENT_ADAPTER_DAEMON.md`](../docs/implementation/CLIENT_ADAPTER_DAEMON.md): Plugin 디렉터리 설정, 런타임의 제약
- **Dependencies**: 없음
- **Patterns to follow**:
  - Daemon은 Plugin을 manifest와 Plugin API로만 다룹니다.
  - Plugin의 진입점 모듈은 자신이 쓰는 라이브러리를 모두 번들하고, `plugin` 하나만 내보냅니다.
- **Patterns to avoid**:
  - Daemon 소스에서 특정 Plugin 모듈을 `import`하거나, 에이전트 id별로 분기하지 않습니다.
  - Plugin이 Daemon 패키지나 다른 Plugin 패키지를 `import`하지 않습니다.
  - Plugin 진입점 모듈의 최상위 코드에서 파일을 읽거나, 감시를 시작하거나, 타이머를 걸지 않습니다.
  - manifest의 `main`이 Plugin 디렉터리 밖을 가리키게 하지 않습니다.

### Verification

- [ ] Daemon 소스와 의존 목록에 특정 Plugin 패키지나 에이전트 id가 없습니다.
- [ ] Daemon을 다시 빌드하지 않고 Plugin 디렉터리에 Plugin을 넣고 Daemon을 다시 시작하면 그 Plugin이 수집을 시작합니다.
- [ ] "사용할 Plugin"에 없는 Plugin은 진입점 모듈이 불리지 않습니다.
- [ ] manifest가 없거나, `agent`가 디렉터리 이름과 다르거나, `api_version`이 다르거나, `plugin`이 없는 Plugin은 로그를 남기고 건너뛰며, 다른 Plugin은 정상적으로 시작합니다.

## Alternatives Considered

- **Plugin을 Daemon 실행 파일에 함께 빌드**: 이전 결정입니다. 배포물이 실행 파일 하나이고 호환성이 빌드할 때 맞춰지지만, Daemon이 모든 Plugin을 알아야 하고 Plugin을 고칠 때마다 Daemon을 다시 빌드해야 해서 대체했습니다.
- **Plugin을 별도 프로세스로 실행**: Plugin의 오류가 Daemon을 멈추지 않고 Plugin을 아무 언어로나 쓸 수 있지만, Daemon과 Plugin 사이에 통신 규약이 하나 더 생기고 Plugin마다 프로세스를 다뤄야 해서 기각했습니다.
- **Plugin 디렉터리의 모든 Plugin을 불러옴**: 설정이 필요 없지만, 사용하지 않는 Plugin의 코드도 실행되고 [Client Adapter Daemon의 설정](../docs/model/CLIENT_ADAPTER_DAEMON.md#설정)의 "사용할 Plugin"과 맞지 않아 기각했습니다.
- **수집할 때 Plugin을 불러옴**: 필요할 때만 불러오지만, 언제 수집할지는 Plugin의 Trigger가 정하므로 Daemon이 그 시점을 알 수 없어 기각했습니다.
- **`submit`이 전송 결과를 돌려줌**: Daemon이 Plugin에 전송 결과를 알리는 방식은 이전에 되돌린 설계이므로 넣지 않았습니다.

## More Information

- 대체하는 ADR: [Bundle Plugins into the Client Adapter Daemon executable](2026-10-22-bundle-plugins-into-daemon-executable.md)
- 고친 ADR: [Implement the Client Adapter Daemon and Plugins in TypeScript](2026-10-22-implement-daemon-and-plugins-in-typescript.md)의 정적 `import` 등록 목록
- 다시 검토할 조건: Plugin의 오류가 Daemon을 멈추는 일이 잦은 경우, 또는 믿을 수 없는 출처의 Plugin을 받아야 하는 경우
