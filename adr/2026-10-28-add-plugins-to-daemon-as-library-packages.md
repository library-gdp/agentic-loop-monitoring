---
status: proposed
date: 2026-10-28
decision-makers: pgd
---

# Add Plugins to the Daemon as library packages

## Context and Problem Statement

[Bundle Plugins into the Client Adapter Daemon executable](2026-10-22-bundle-plugins-into-daemon-executable.md)은 Plugin을 Daemon 실행 파일에 함께 빌드하기로 했지만, Plugin을 등록하는 구체적인 방법은 범위 밖으로 남겼습니다. [Implement the Client Adapter Daemon and Plugins in TypeScript](2026-10-22-implement-daemon-and-plugins-in-typescript.md)은 Plugin과 Daemon 사이 인터페이스를 TypeScript 타입으로 정의하기로 했고, [Let each Plugin define its read trigger and reading method](2026-10-22-let-plugins-define-read-trigger-and-method.md)과 [Let each Plugin define the Batch unit](2026-10-28-let-plugins-define-batch-unit.md)은 그 인터페이스를 범위 밖으로 남겼습니다. Plugin을 구현하려면 Plugin이 구현할 인터페이스와 Plugin을 Daemon에 넣는 방법을 정해야 합니다.

## Decision

Plugin은 에이전트마다 패키지 하나로 만들고, Daemon은 이 패키지를 라이브러리로 가져다 씁니다.

- **Plugin API 패키지**: [Plugin Interface](../docs/implementation/PLUGIN_INTERFACE.md)의 타입(`Plugin`, `PluginContext`, `PluginBatch`, Session Log Event)만 담습니다. Daemon과 모든 Plugin은 이 타입만 참조합니다.
- **Plugin 패키지**: `Plugin`을 구현한 객체 하나를 `plugin`으로 내보냅니다. Plugin API를 `peerDependencies`로 선언하며, Daemon이나 다른 Plugin에 의존하지 않습니다. 불러오기만으로는 부수 효과가 없으며, 수집은 `start`에서 시작합니다. `version`은 패키지 버전과 같고 Batch의 `source.plugin_version`이 됩니다.
- **Daemon**: Plugin 패키지를 `dependencies`로 선언하고, 정적 `import`로 모은 등록 목록 하나에서 에이전트 id로 Plugin을 찾습니다.
- **인터페이스**:
  - Daemon은 활성화한 Plugin마다 `start(context)`를, 종료할 때 `stop()`을 부릅니다.
  - Plugin은 `context.submit(batch)`로 Batch 하나를 넘깁니다. `submit`은 전송 대기열에 넣고 바로 돌아오며 전송 결과를 돌려주지 않습니다.
  - Plugin은 `context.logger`로 Daemon의 로그 파일에 기록합니다.
  - `PluginBatch`는 Batch에서 Daemon이 채우는 `protocol_version`, `batch_id`, `source`를 뺀 것이며, 필드 이름은 Agent Logging Protocol과 같습니다.

**범위 밖**

- 패키지 이름, 저장소 구성(같은 저장소의 workspace 또는 따로 배포하는 패키지), 패키지 관리 도구
- Plugin이 자신의 상태를 저장하는 위치
- TypeScript를 실행할 런타임과 Daemon을 실행 파일 하나로 빌드하는 방법

## Consequences

- Good, because Plugin과 Daemon 사이의 의존이 Plugin API 패키지 하나로 드러납니다. Plugin이 Daemon 내부를 부를 수 없으므로 [Plugin Specification](../docs/model/PLUGIN_SPEC.md#daemon과의-관계)의 "Plugin은 다른 Plugin이나 Daemon 내부를 직접 부르지 않습니다"를 패키지 의존으로 지킬 수 있습니다.
- Good, because Plugin 패키지를 Daemon 없이 따로 빌드하고 테스트할 수 있습니다.
- Good, because Plugin마다 버전이 있어 Main Server의 수신 기록에서 어느 Plugin 버전이 만든 Session Log Event인지 알 수 있습니다.
- Good, because `PluginBatch`의 필드 이름이 Batch와 같아 Daemon이 변환 없이 직렬화합니다.
- Bad, because Plugin API를 바꾸면 모든 Plugin 패키지를 함께 고쳐야 Daemon이 빌드됩니다.
- Bad, because Plugin이 전송 결과를 받지 못하므로, 재시도를 모두 실패한 Batch를 Plugin이 다시 수집해 보낼 수 없습니다. 이 문제는 [결정되지 않은 사항](../docs/model/CLIENT_ADAPTER_DAEMON.md#결정되지-않은-사항)으로 남아 있습니다.

## Implementation Plan

- **Affected paths**: 아직 코드가 없습니다. 설계 문서는 다음과 같습니다.
  - [`docs/implementation/PLUGIN_INTERFACE.md`](../docs/implementation/PLUGIN_INTERFACE.md): Plugin 인터페이스
  - [`docs/implementation/PLUGIN_GUIDE.md`](../docs/implementation/PLUGIN_GUIDE.md): 패키지 구성과 Plugin을 Daemon에 추가하는 방법
- **Dependencies**: 없음
- **Patterns to follow**:
  - Plugin 패키지는 진입점에서 `plugin` 하나만 내보냅니다.
  - Daemon은 Plugin을 등록 목록에서만 참조합니다.
- **Patterns to avoid**:
  - Plugin 패키지가 Daemon 패키지나 다른 Plugin 패키지를 `import`하지 않습니다.
  - Plugin 패키지의 최상위 코드에서 파일을 읽거나, 감시를 시작하거나, 타이머를 걸지 않습니다.
  - Plugin API 패키지에 타입이 아닌 코드를 두지 않습니다.

### Verification

- [ ] 모든 Plugin 패키지가 `Plugin`을 구현한 `plugin`을 내보내며, 타입 검사를 통과합니다.
- [ ] Plugin 패키지의 의존 목록에 Daemon 패키지와 다른 Plugin 패키지가 없습니다.
- [ ] 등록 목록의 Plugin은 `agent`가 서로 다릅니다.
- [ ] 각 Plugin의 `version`이 그 패키지의 버전과 같습니다.
- [ ] Plugin 패키지를 불러오기만 하고 `start`를 부르지 않으면 Session Log를 읽지 않습니다.

## Alternatives Considered

- **Daemon 소스 안의 디렉터리로 Plugin을 둠**: 패키지를 나누지 않아 구성이 단순하지만, Plugin이 Daemon 내부를 `import`하는 것을 막을 수 없고 Plugin마다 버전을 매길 단위가 없어 기각했습니다.
- **`submit`이 전송 결과를 돌려줌**: Plugin이 성공한 Batch까지만 수집한 것으로 확정할 수 있지만, Daemon이 Plugin에 전송 결과를 알리는 방식은 이전에 되돌린 설계이므로 넣지 않았습니다.
- **Plugin이 Session Log Event를 콜백 대신 비동기 iterator로 내보냄**: Daemon이 Plugin마다 iterator를 돌려야 하고, Trigger가 여러 개인 Plugin에서 다루기 어려워 기각했습니다.

## More Information

- 관련 ADR: [Bundle Plugins into the Client Adapter Daemon executable](2026-10-22-bundle-plugins-into-daemon-executable.md), [Implement the Client Adapter Daemon and Plugins in TypeScript](2026-10-22-implement-daemon-and-plugins-in-typescript.md), [Let each Plugin define the Batch unit](2026-10-28-let-plugins-define-batch-unit.md)
- 다시 검토할 조건: Daemon 소스를 빌드하지 않는 사람이 Plugin을 추가해야 하는 경우, 또는 재시도를 모두 실패한 Batch를 다시 보내는 방법을 정하는 경우
