---
status: accepted
date: 2026-10-28
decision-makers: pgd
---

# Let each Plugin define the Batch unit

## Context and Problem Statement

[Let each Plugin define its read trigger and reading method](2026-10-22-let-plugins-define-read-trigger-and-method.md)은 Session Log를 언제, 어떻게 수집할지를 Plugin에 맡겼지만, Batch는 Daemon이 만들었습니다. Plugin이 한 Agent의 끝난 Turn 단위로 Session Log Event를 넘기면, Daemon이 이를 Batch 크기 한도 안에서 Batch로 묶었습니다.

하지만 Batch를 올바르게 묶는 데 필요한 정보는 Plugin에 있습니다.

- 어떤 Session Log Event가 어느 Session, 어느 Agent, 어느 Turn에 속하는지는 Plugin이 Session Log를 해석해 알아냅니다. Daemon이 Batch를 묶으려면 Plugin이 이미 아는 경계를 다시 다뤄야 합니다.
- 한 번에 수집하는 Turn의 수와 크기는 Trigger와 수집 방식에 따라 달라집니다. 예를 들어 Turn이 끝날 때마다 발동하는 Trigger는 Turn 하나씩 수집하고, 주기적으로 확인하는 Trigger는 여러 Turn을 한 번에 수집합니다. 어떻게 묶는 것이 알맞은지도 에이전트마다 다릅니다.
- Daemon이 여러 번에 걸쳐 넘겨받은 Turn을 합치려면 Session과 Agent별로 Session Log Event를 모아 두었다가 언제 보낼지 판단해야 합니다.

## Decision

Batch 단위는 각 Plugin이 정의합니다.

- **Plugin**: 변환한 Session Log Event를 자신이 정의한 Batch 단위로 묶어 Daemon에 넘깁니다. 끝난 Turn을 어떻게 Batch로 묶는지(예: Turn마다 Batch 하나, 한 번 수집한 범위에서 Agent마다 Batch 하나)와 Batch 하나에 담는 Session Log Event 수와 바이트 수의 최댓값을 정의하고, 에이전트별 문서에 적습니다.
- **Daemon**: Plugin이 넘긴 묶음을 합치거나 나누지 않고 Batch 하나로 Main Server에 보냅니다. `protocol_version`, `batch_id`, `source`만 채우고, Session ID, Agent ID, 부모 Agent ID, 작업 디렉터리, Session Log Event는 Plugin이 넘긴 값을 그대로 씁니다. 재시도와 Ack 처리는 그대로 Daemon이 맡습니다.
- **공통 규칙**: Plugin은 어떻게 묶든 [Plugin Specification의 Batch 단위](../docs/model/PLUGIN_SPEC.md#batch-단위) 규칙을 지킵니다.
  1. 한 Batch에는 한 Session, 한 Agent의 Session Log Event만 담습니다.
  2. 끝난 Turn을 하나 이상 온전히 담으며, Turn 하나를 여러 Batch에 나누지 않습니다.
  3. Batch 안의 Session Log Event는 Session Log에 기록된 순서를 따릅니다.
  4. 최댓값을 넘지 않습니다. 다만 Turn 하나가 최댓값보다 크면 그 Turn만 담습니다.

**범위 밖**

- Main Server가 받아들이는 Batch 크기의 상한과, 그 상한과 Plugin이 정한 최댓값의 관계
- Plugin이 Batch를 Daemon에 넘기는 TypeScript 인터페이스
- 각 Plugin의 구체적인 Batch 단위와 최댓값. 에이전트별 문서에서 정합니다.
- 재시도를 모두 실패한 Batch를 나중에 다시 보내는 방법

## Consequences

- Good, because Daemon은 Session Log Event를 모아 두거나 Turn과 Agent의 경계를 다루지 않습니다. Daemon 설정에서 Batch 크기 한도가 빠집니다.
- Good, because Plugin마다 Trigger와 수집 방식에 맞춰 Batch를 묶을 수 있습니다.
- Bad, because Batch를 묶고 최댓값을 지키는 코드를 Plugin마다 따로 구현해야 합니다. 공통 코드로 뺄지는 Plugin을 구현할 때 정합니다.
- Bad, because Batch 크기가 Plugin마다 달라집니다. Main Server의 상한이 정해지면 각 Plugin의 최댓값이 그보다 크지 않은지 확인해야 합니다.
- Bad, because Daemon이 Batch 규칙을 다시 확인하지 않으므로, 규칙을 어긴 Plugin의 Batch는 그대로 Main Server에 갑니다. Plugin마다 규칙을 지키는지 테스트로 확인해야 합니다.

## Implementation Plan

- **Affected paths**: 아직 코드가 없습니다. 설계 문서는 다음과 같습니다.
  - [`docs/model/PLUGIN_SPEC.md`](../docs/model/PLUGIN_SPEC.md): Plugin의 역할, Batch 단위와 규칙, Daemon과의 관계, 에이전트별 문서에 적을 것
  - [`docs/model/CLIENT_ADAPTER_DAEMON.md`](../docs/model/CLIENT_ADAPTER_DAEMON.md): Batch 받기, 설정에서 Batch 크기 한도 삭제
  - [`docs/model/SYSTEM_ARCHITECTURE.md`](../docs/model/SYSTEM_ARCHITECTURE.md), [`docs/model/GLOSSARY.md`](../docs/model/GLOSSARY.md): 구성, 데이터 흐름, Plugin과 Batch의 정의
  - [`docs/implementation/CLIENT_ADAPTER_DAEMON.md`](../docs/implementation/CLIENT_ADAPTER_DAEMON.md): Batch 크기 한도의 기본값 삭제
  - [`docs/implementation/plugin/`](../docs/implementation/plugin/): 에이전트별 Batch 단위와 최댓값. 각 Plugin을 구현할 때 적습니다.
- **Dependencies**: 없음
- **Patterns to follow**:
  - Batch를 묶는 코드는 그 Plugin 모듈 안에 둡니다. 여러 Plugin이 같은 방식을 쓰면 Plugin이 가져다 쓰는 공통 코드로 뺄 수 있습니다.
- **Patterns to avoid**:
  - Daemon 코드에서 Plugin이 넘긴 묶음을 합치거나, 나누거나, Session과 Agent별로 모아 두지 않습니다.
  - Daemon 설정에 Batch 크기 한도를 두지 않습니다.

### Verification

- [ ] Daemon 소스와 Daemon 설정에 Batch 크기 한도가 없습니다.
- [ ] Plugin이 넘긴 묶음 하나마다 Daemon이 Batch 하나를 보내며, 그 `events`가 Plugin이 넘긴 Session Log Event와 같습니다.
- [ ] 각 Plugin의 테스트에서 모든 Batch가 한 Session, 한 Agent의 Session Log Event만 담고, `user_message`로 시작하며, 끝난 Turn만 담습니다.
- [ ] 각 Plugin의 테스트에서 Turn 하나보다 큰 Batch가 Plugin이 정한 최댓값을 넘지 않습니다.
- [ ] 각 Plugin의 에이전트별 문서에 Batch 단위와 최댓값이 적혀 있습니다.

## Alternatives Considered

- **Daemon이 Batch 크기 한도 안에서 Turn을 묶음**: 이전 결정입니다. 묶는 규칙을 Daemon 한 곳에서 구현하면 되지만, Plugin이 이미 아는 Session, Agent, Turn의 경계를 Daemon이 다시 다뤄야 하고 Session Log Event를 모아 두었다가 보낼 시점을 정해야 해서 대체했습니다.
- **Daemon이 Turn마다 Batch 하나를 보냄**: Daemon이 묶을 필요가 없어 단순하지만, 여러 Turn을 한 번에 수집하는 Plugin도 Turn 수만큼 Batch를 보내고 Ack를 기다려야 합니다. Plugin마다 수집 방식에 맞춰 고를 수 있도록 Plugin에 맡겼습니다. Plugin은 이 방식을 자신의 Batch 단위로 고를 수 있습니다.

## More Information

- 대체하는 부분: [Let each Plugin define its read trigger and reading method](2026-10-22-let-plugins-define-read-trigger-and-method.md)의 "Daemon이 Plugin이 넘긴 Session Log Event를 Batch로 묶는다"는 결정
- 관련 ADR: [Split the system into a Client Adapter Daemon and a Main Server](2026-10-19-split-system-into-client-adapter-daemon-and-main-server.md)
- 용어: [Glossary](../docs/model/GLOSSARY.md)
- 다시 검토할 조건: 여러 Plugin이 같은 방식으로 Batch를 묶게 되는 경우, 또는 Main Server의 Batch 크기 상한을 정하는 경우
