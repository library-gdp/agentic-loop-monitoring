---
status: superseded
date: 2026-10-19
decision-makers: pgd
---

# Read Session Log Files incrementally from an Ack-confirmed offset

> Superseded by [Let each Plugin define its read trigger and reading method](2026-10-22-let-plugins-define-read-trigger-and-method.md). 이 ADR의 Hook Client, Signal, Offset, Offset Store는 더 이상 쓰지 않습니다.

## Context and Problem Statement

Client Adapter Daemon(이하 Daemon)은 에이전트의 Session Log File을 읽어 Session Log Event로 변환하고 Main Server로 보냅니다([Split the system into a Client Adapter Daemon and a Main Server](2026-10-19-split-system-into-client-adapter-daemon-and-main-server.md) 참고). Session Log File은 에이전트가 Session 동안 계속 덧붙여 쓰는 파일이며, 긴 Session에서는 수 MB까지 커집니다.

두 가지를 정해야 합니다.

1. Daemon이 언제 읽기 시작하는가
2. 매번 어디부터 읽는가

Stop Hook이 올 때마다 파일 전체를 다시 읽으면, Turn이 늘어날수록 읽고 변환하고 보내는 양이 Session 크기에 비례해 커집니다. 한편 Main Server는 원격에 있을 수 있으므로 전송이 실패할 수 있습니다. 시스템은 Fail-open 원칙에 따라 이벤트 유실을 허용하지만, 일시적인 전송 실패로 데이터를 잃는 것은 피하고 싶습니다.

## Decision

- **Trigger**: Daemon은 에이전트의 Stop Hook에만 반응합니다. Stop Hook이 실행하는 Hook Client는 Daemon에 Signal만 보내고, 처리를 기다리지 않고 바로 종료합니다. Daemon은 Signal을 받지 않으면 Session Log File을 읽지 않습니다. 시작할 때 미리 훑거나 파일 변경을 감시하지도 않습니다.
- **Offset**: Daemon은 Session별로 Offset(Session Log File 처음부터 센 바이트 수)을 저장합니다. 그 Session의 Signal을 받으면 Offset부터 읽습니다. Offset은 상태 디렉터리 아래 `offsets/<agent>/<session_id>.json`에 Session마다 파일 하나로 기록합니다.
- **갱신 시점**: Daemon은 Batch를 보낸 뒤 Main Server의 Ack를 기다립니다. 성공 Ack를 받은 뒤에만 Offset을 Batch의 끝으로 갱신합니다. Daemon은 비동기일 필요가 없으며, Signal을 하나씩 순서대로 처리합니다.
- **읽는 범위**: Daemon은 Signal 처리를 시작할 때 Plugin에게서 끝 위치를 받고, 그 Signal의 처리에서는 끝 위치까지만 읽습니다. 끝 위치를 어떻게 정하고 나타낼지는 Plugin이 정합니다.
- **Turn 단위**: Plugin은 끝난 Turn까지만 소비하므로 Offset은 항상 Turn의 경계에 있습니다. Main Server는 끝난 Turn만 받으며, Turn 하나가 여러 Batch에 나뉘지 않습니다. 사용자가 중단한 Turn은 Plugin이 걸러내고 보내지 않습니다.
- **중복 처리**: 성공 Ack 전에 실패한 구간은 다시 보내므로, 같은 Session Log Event가 여러 번 도착할 수 있습니다. Plugin은 다시 읽어도 바뀌지 않는 event id를 붙입니다. Main Server는 `(agent, session id, event id)`가 이미 저장되어 있으면 무시하고 `accepted`로 응답합니다.
- **경계 상황**:
  - Plugin은 완결된 레코드까지만 읽습니다. 끝나지 않은 Turn은 다음 읽기에서 그 Turn의 처음부터 다시 읽습니다.
  - Session Log File이 바뀌었는지와 그때 처음부터 다시 읽을지는 Plugin이 판단합니다. Daemon은 파일의 경로나 inode를 기록하지 않습니다.
  - Offset 레코드 파일은 임시 파일에 쓰고 `fsync`한 뒤 rename해서 원자적으로 갱신합니다.

세부 규칙은 [Client Adapter Daemon](../docs/model/CLIENT_ADAPTER_DAEMON.md)과 [Plugin Specification](../docs/model/PLUGIN_SPEC.md)에 있습니다.

**범위 밖**

- 진행 중인 Turn의 실시간 표시. Stop Hook만 쓰므로 데이터는 Turn이 끝날 때 들어옵니다.
- 덧붙여 쓰는 단일 파일이 아닌 Session Log File의 처리
- Hook Client 타임아웃, Ack 타임아웃, 재시도 횟수, Batch 크기 한도의 기본값

## Consequences

- Good, because Stop Hook 한 번에 읽는 양이 Session 전체가 아니라 직전 Turn에 비례합니다.
- Good, because 일시적인 전송 실패나 Daemon 중단으로는 데이터를 잃지 않습니다. Offset이 그대로 남으므로 같은 Session의 다음 Stop Hook 때 다시 보냅니다.
- Good, because Offset을 Session마다 따로 기록하므로, 한 Session을 갱신하거나 레코드가 손상되어도 다른 Session에 영향이 없습니다.
- Good, because Core는 진행 중인 Turn을 들고 있을 필요 없이 Batch 안에서 Turn을 구성할 수 있습니다.
- Good, because 에이전트가 파일에 계속 쓰더라도 Signal 하나의 처리는 끝 위치에서 끝나므로, 한 Session이 Worker를 붙잡고 있지 않습니다.
- Bad, because Main Server가 event id로 중복을 걸러내야 합니다. 그래서 Ingest API는 멱등이어야 합니다.
- Bad, because Plugin의 event id는 결정적이어야 하고, 읽기를 이어갈 문맥이 필요하면 Plugin State로 넘겨야 합니다. Plugin 구현이 그만큼 까다로워집니다.
- Bad, because 전송에 실패한 뒤 그 Session에 Stop Hook이 다시 오지 않으면 남은 구간은 보내지 않습니다. 유실을 허용한다는 원칙에 따라 이를 받아들입니다.
- Bad, because Turn의 끝을 알아보는 방법이 에이전트마다 달라 Plugin이 알아야 합니다. 에이전트가 사용자 중단을 기록하지 않으면 중단된 Turn을 걸러낼 수 없습니다.
- Bad, because 끝나지 않은 Turn은 보내지 않습니다. 에이전트가 충돌로 종료되면 그 Session의 마지막 Turn은 유실됩니다. 또 Turn 하나가 Batch 크기 한도보다 크면 그 Turn만 담은 큰 Batch를 보냅니다.
- Bad, because Daemon이 Ack를 기다리는 동안 다른 Session의 Signal은 큐에서 기다립니다. Ack 타임아웃과 재시도 횟수로 기다리는 시간의 상한을 둡니다.

## Implementation Plan

- **Affected paths**: 아직 코드가 없습니다. 설계 문서는 다음과 같습니다.
  - [`docs/model/CLIENT_ADAPTER_DAEMON.md`](../docs/model/CLIENT_ADAPTER_DAEMON.md): Signal 처리, Ack 처리, Offset Store, Offset 검증
  - [`docs/model/PLUGIN_SPEC.md`](../docs/model/PLUGIN_SPEC.md): `read`의 Turn 단위 규칙, Plugin State, event id
  - [`docs/model/AGENT_LOGGING_PROTOCOL.md`](../docs/model/AGENT_LOGGING_PROTOCOL.md): Ack 형식, `retryable`, 중복 처리 규칙
  - 코드 디렉터리 구성은 구현 언어를 정하는 ADR에서 정합니다.
- **Dependencies**: 없음
- **Patterns to follow**:
  - Offset 갱신은 항상 성공 Ack 처리 경로에서만 일어납니다. 재시도할 수 없는 거절은 예외이며, 이때는 Batch를 버리고 Offset을 넘깁니다.
  - Offset과 Plugin State는 한 번의 원자적 쓰기로 함께 갱신합니다.
  - Main Server는 Batch의 Session Log Event를 모두 저장한 뒤에 `accepted`를 보냅니다.
- **Patterns to avoid**:
  - Batch를 보내기 전이나 Ack를 받기 전에 Offset을 갱신하지 않습니다.
  - Offset 레코드 파일을 제자리에서 덮어쓰지 않습니다.
  - event id를 현재 시각이나 난수로 만들지 않습니다.
  - Stop Hook 말고 다른 Hook에서 읽기를 시작하지 않습니다.

### Verification

- [ ] 같은 Session에 Stop Hook이 두 번 오면 두 번째에는 첫 번째 성공 Ack 이후에 덧붙은 바이트만 읽습니다.
- [ ] Main Server를 멈춘 상태에서 Stop Hook이 오면 Offset 레코드 파일이 바뀌지 않습니다. Main Server를 다시 띄우고 다음 Stop Hook이 오면 빠졌던 구간까지 저장됩니다.
- [ ] 같은 Batch를 Main Server에 두 번 보내도 저장된 Session Log Event 수가 한 번 보낸 것과 같습니다.
- [ ] Session Log File의 마지막 줄이 줄바꿈 없이 끝나 있으면 그 줄이 속한 Turn은 보내지 않습니다. 줄이 완성되고 Turn이 끝난 뒤 다음 Stop Hook에서 보냅니다.
- [ ] Signal 처리를 시작한 뒤 덧붙은 바이트는 그 Signal의 처리에서 읽지 않습니다.
- [ ] 끝 위치까지 다음 Turn의 앞부분만 기록되어 있으면 그 부분은 보내지 않고, Offset은 그 Turn의 시작에 머무릅니다.
- [ ] 모든 Batch는 `user_message`로 시작하고 끝난 Turn만 담습니다.
- [ ] 사용자가 중단한 Turn은 Main Server에 보내지 않으며, Offset은 그 Turn 뒤로 넘어갑니다.
- [ ] Offset 레코드 파일 하나를 손상시키면 그 Session만 처음부터 다시 읽고, 다른 Session의 Offset은 그대로입니다.
- [ ] Offset을 갱신하는 도중 Daemon을 강제로 종료해도 Offset 레코드 파일은 이전 값이나 새 값 중 하나로 남습니다.

## Alternatives Considered

- **매번 파일 전체를 다시 읽고 Main Server에서 중복 제거**: 구현은 단순합니다. 하지만 Stop Hook마다 Session 전체를 읽고 보내므로, 긴 Session일수록 비용이 커져서 기각했습니다.
- **읽자마자 Offset 갱신**: Ack를 기다릴 필요가 없고 중복도 생기지 않습니다. 하지만 일시적인 전송 실패만으로 그 구간이 영구히 유실되어 기각했습니다.
- **파일 변경 감시(inotify, FSEvents)로 읽기 시작**: 진행 중인 Turn도 거의 실시간으로 볼 수 있습니다. 하지만 Trigger는 Stop Hook 하나로 두기로 했으므로 기각했습니다.

## More Information

- 관련 ADR: [Split the system into a Client Adapter Daemon and a Main Server](2026-10-19-split-system-into-client-adapter-daemon-and-main-server.md)
- 용어: [Glossary](../docs/model/GLOSSARY.md)
- 다시 검토할 조건: 진행 중인 Turn을 실시간으로 보여줘야 하는 경우, 또는 Session Log File을 덧붙여 쓰지 않는 에이전트를 지원해야 하는 경우
