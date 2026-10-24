---
status: accepted
date: 2026-10-22
decision-makers: pgd
---

# Let each Plugin define its read trigger and reading method

## Context and Problem Statement

[Read Session Log Files incrementally from an Ack-confirmed offset](2026-10-19-read-session-log-files-incrementally-from-acked-offset.md)은 모든 에이전트에 같은 방식을 적용했습니다. Daemon이 Stop Hook으로 실행되는 Hook Client에게서 Signal을 받으면 읽기를 시작하고, Session별 바이트 Offset을 Offset Store에 저장해 그 위치부터 읽었습니다.

이 방식은 모든 에이전트가 Turn이 끝날 때 Hook을 제공하고, Session 하나를 덧붙여 쓰는 파일 하나에 기록한다는 전제에 기대고 있습니다. 하지만 에이전트마다 외부에 알려 주는 시점과 Session Log File의 형식, 파일 구성이 다릅니다. Daemon이 하나의 Trigger와 하나의 읽는 방식을 정하면, 그 전제에 맞지 않는 에이전트를 지원할 수 없습니다.

## Decision

Session Log File을 읽는 Trigger와 읽는 방식을 각 Plugin이 정의합니다.

- **Trigger**: Plugin마다 언제 읽기를 시작할지 정합니다. Daemon은 Hook Client와 Signal을 두지 않습니다.
- **읽는 방식**: Plugin마다 Session Log File을 찾고, 어디까지 읽었는지 기록하고, 이어 읽는 방법을 정합니다. Daemon은 Offset과 Offset Store를 두지 않습니다.
- **Daemon의 역할**: Plugin이 끝난 Turn 단위로 넘긴 Session Log Event를 Batch로 묶어 Main Server에 보냅니다.
- **공통 규칙**: Plugin은 어떤 Trigger와 읽는 방식을 정의하든 [Plugin Specification](../docs/model/PLUGIN_SPEC.md)의 규칙을 지킵니다. 에이전트를 기다리게 하지 않고, 끝난 Turn만 넘깁니다.

**범위 밖**

- Plugin과 Daemon 사이의 TypeScript 인터페이스
- Plugin이 자신의 상태를 저장하는 위치
- 재시도를 모두 실패한 Batch를 나중에 다시 보내는 방법
- 각 에이전트의 구체적인 Trigger와 읽는 방식. 에이전트별 문서에서 정합니다.

## Consequences

- Good, because 에이전트가 제공하는 기능과 Session Log File의 구성에 맞춰 Plugin마다 가장 알맞은 Trigger와 읽는 방식을 고를 수 있습니다.
- Good, because Daemon은 Batch 전송과 Ack 처리만 맡으므로 단순해지고, 에이전트별 차이가 Plugin 안에 갇힙니다.
- Bad, because 읽은 위치를 기록하고 이어 읽는 코드를 Plugin마다 따로 구현해야 합니다.
- Bad, because 유실되는 경우와 전달 보장의 세부가 Plugin마다 달라집니다. 에이전트별 문서에 적어 차이를 드러내야 합니다.

## Implementation Plan

- **Affected paths**: 아직 코드가 없습니다. 설계 문서는 다음과 같습니다.
  - [`docs/model/PLUGIN_SPEC.md`](../docs/model/PLUGIN_SPEC.md): Plugin이 정의하는 Trigger와 읽는 방식, 지켜야 하는 규칙
  - [`docs/model/CLIENT_ADAPTER_DAEMON.md`](../docs/model/CLIENT_ADAPTER_DAEMON.md): Batch 전송
  - [`docs/model/SYSTEM_ARCHITECTURE.md`](../docs/model/SYSTEM_ARCHITECTURE.md): 구성, 데이터 흐름, 전달 보장
  - [`docs/model/GLOSSARY.md`](../docs/model/GLOSSARY.md): Hook, Signal, Offset 관련 용어 삭제와 Trigger 추가
- **Dependencies**: 없음
- **Patterns to follow**:
  - Trigger와 읽는 방식에 관한 코드는 그 Plugin 모듈 안에만 둡니다.
- **Patterns to avoid**:
  - Daemon 코드에서 Session Log File을 직접 읽거나 Plugin의 읽은 위치를 저장하지 않습니다.
  - 특정 에이전트의 Trigger를 Daemon 공통 기능으로 만들지 않습니다.

### Verification

- [ ] Daemon 소스에 Hook Client, Signal, Offset Store가 없습니다.
- [ ] 각 Plugin의 에이전트별 문서에 Trigger와 읽는 방식이 적혀 있습니다.

## Alternatives Considered

- **Daemon이 Stop Hook과 바이트 Offset으로 모든 에이전트를 읽음**: 이전 결정입니다. Daemon 한 곳에서 구현하면 되지만, Hook을 제공하지 않거나 Session을 덧붙여 쓰는 파일 하나에 기록하지 않는 에이전트를 지원할 수 없어 대체했습니다.

## More Information

- 대체하는 ADR: [Read Session Log Files incrementally from an Ack-confirmed offset](2026-10-19-read-session-log-files-incrementally-from-acked-offset.md)
- 관련 ADR: [Split the system into a Client Adapter Daemon and a Main Server](2026-10-19-split-system-into-client-adapter-daemon-and-main-server.md)
