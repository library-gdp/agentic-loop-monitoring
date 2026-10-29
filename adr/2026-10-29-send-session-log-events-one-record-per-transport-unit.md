---
status: accepted
date: 2026-10-29
decision-makers: pgd
---

# Send Session Log Events one record per Transport Unit

## Context and Problem Statement

Client Adapter Daemon과 Main Server 사이에서 Session Log Event를 주고받는 단위를 정해야 합니다. 이 단위가 크면 Daemon과 Main Server가 그 단위 전체를 메모리에 올려 두어야 합니다. 끝난 Turn 하나를 한 번에 보내면, 큰 도구 결과가 많은 Turn에서 이 크기가 수십 MB가 될 수 있습니다.

[Run the Client Adapter Daemon and the Main Server in one Bun process](2026-10-29-run-daemon-and-main-server-in-one-bun-process.md)는 메모리 사용량을 다른 기준보다 우선합니다. Daemon과 Main Server가 한 프로세스에서 메모리를 함께 쓰므로, 한 번에 다루는 데이터의 크기가 곧 프로세스의 최대 메모리를 정합니다.

## Decision

Daemon과 Main Server 사이의 데이터 송수신 단위를 **Transport Unit**이라고 부르고, Transport Unit 하나에 **Session Log의 레코드 하나**에서 나온 Session Log Event를 담습니다.

- Plugin은 레코드 하나를 Session Log Event로 변환할 때마다 Transport Unit 하나로 Daemon에 넘깁니다. Session Log Event가 나오지 않는 레코드는 넘기지 않습니다.
- Daemon은 Transport Unit을 합치거나 나누지 않고, 하나씩 보내고 Ack를 기다립니다.
- Plugin은 여전히 끝난 Turn의 레코드만 넘기고, 사용자가 중단한 Turn은 걸러냅니다. Turn의 레코드는 Session Log에 기록된 순서대로 넘깁니다.
- Transport Unit 하나에 Turn 전체가 담기지 않으므로, Plugin이 Turn 정보를 Transport Unit에 싣습니다.
  - `turn.id`: Turn을 시작한 `user_message`의 `event_id`
  - `turn.position`: `events`의 첫 Session Log Event의 Turn 안 위치
  - `turn.last`: 그 Turn의 마지막 Transport Unit인지
- Main Server는 Transport Unit 하나를 원자적으로 저장하고, 그 Transport Unit이 속한 Turn의 파생 데이터를 다시 만든 뒤 `accepted`를 돌려줍니다.
- 마지막 Transport Unit을 아직 받지 못한 Turn의 상태는 `incomplete`입니다.
- Plugin은 송수신 단위를 정의하지 않습니다. 단위는 모든 Plugin에서 레코드 하나입니다.

**범위 밖**

- 레코드 하나가 아주 클 때 Main Server가 받아들이는 Transport Unit 크기의 상한
- 여러 Transport Unit을 하나의 트랜잭션으로 모아 쓰는 최적화

## Consequences

- Good, because Daemon과 Main Server가 한 번에 다루는 데이터가 레코드 하나 크기로 제한됩니다. 최대 메모리가 Turn의 크기에 따라 커지지 않습니다.
- Good, because Plugin마다 송수신 단위를 정의하고 문서화할 필요가 없습니다.
- Good, because Turn 정보가 Transport Unit에 실려 오므로, Main Server는 Transport Unit의 경계에 기대지 않고 Session Log Event의 소속 Turn과 Turn 안 위치를 정합니다.
- Bad, because Transport Unit 수와 트랜잭션 수가 레코드 수만큼 늘어납니다. `synchronous=FULL`에서는 Transport Unit마다 디스크 동기화가 일어나므로 처리량이 줄어듭니다.
- Bad, because Turn이 여러 Transport Unit에 나뉘어 도착하므로, Turn의 일부만 저장된 상태가 생깁니다. Daemon이 Turn 도중에 멈추거나 Transport Unit 하나가 거절되면 그 Turn은 `incomplete`로 남을 수 있습니다.
- Bad, because Transport Unit마다 그 Turn의 파생 데이터를 다시 만들므로, Turn 하나를 저장하는 비용이 Turn의 레코드 수의 제곱에 비례합니다. 느려지면 파생 데이터를 바뀐 부분만 고치는 방식으로 바꿉니다.

## Implementation Plan

- **Affected paths**: 아직 코드가 없습니다. 설계 문서는 다음과 같습니다.
  - [`docs/model/AGENT_LOGGING_PROTOCOL.md`](../docs/model/AGENT_LOGGING_PROTOCOL.md): Transport Unit과 Ack의 필드
  - [`docs/model/PLUGIN_SPEC.md`](../docs/model/PLUGIN_SPEC.md): Plugin이 Transport Unit을 넘기는 규칙
  - [`docs/model/CLIENT_ADAPTER_DAEMON.md`](../docs/model/CLIENT_ADAPTER_DAEMON.md): Transport Unit 전송과 Ack 처리
  - [`docs/model/DOMAIN_MODEL.md`](../docs/model/DOMAIN_MODEL.md): Turn 구성 규칙과 `incomplete` 상태
  - [`docs/model/DATA_ARCHITECTURE.md`](../docs/model/DATA_ARCHITECTURE.md): 수신 기록, Session Log Event의 `ends_turn`, 쓰기 절차
  - [`docs/implementation/TABLE_DEFINITION.md`](../docs/implementation/TABLE_DEFINITION.md), [`docs/implementation/DATA_STORAGE.md`](../docs/implementation/DATA_STORAGE.md), [`docs/implementation/MESSAGE_CONVENTION.md`](../docs/implementation/MESSAGE_CONVENTION.md), [`docs/implementation/TRANSPORT.md`](../docs/implementation/TRANSPORT.md)
- **Dependencies**: 없음
- **Patterns to follow**:
  - Plugin은 레코드를 하나씩 읽고 변환해 넘기며, Turn 전체의 Session Log Event를 메모리에 모아 두지 않습니다.
  - Main Server의 Session Log Event의 소속 Turn과 위치는 Transport Unit의 `turn` 필드로만 정합니다.
- **Patterns to avoid**:
  - Daemon이 여러 Transport Unit을 합쳐 보내지 않습니다.
  - Main Server가 Transport Unit이 도착한 순서로 Turn 안 위치를 정하지 않습니다.

### Verification

- [ ] 모든 Transport Unit의 `events`가 Session Log의 레코드 하나에서 나옵니다.
- [ ] 같은 Transport Unit을 두 번 받아도 원본 데이터와 파생 데이터가 한 번 받은 것과 같습니다.
- [ ] Turn의 마지막 Transport Unit을 받기 전에는 그 Turn이 `incomplete`이고, 받은 뒤에는 `completed` 또는 `errored`입니다.

## Alternatives Considered

- **끝난 Turn 하나 이상을 한 번에 보내기**: Main Server가 Turn을 한 번에 받으므로 Turn의 일부만 저장된 상태가 없고 트랜잭션 수가 적습니다. 하지만 최대 메모리가 가장 큰 Turn의 크기에 따라 커지고, 묶는 방식을 Plugin마다 정의해야 합니다. 메모리를 우선하므로 기각했습니다.
- **Session Log Event 하나씩 보내기**: 단위가 가장 작지만, 레코드 하나에서 나온 Session Log Event들이 나뉘어 저장되고 Transport Unit 수가 더 늘어납니다. 레코드 하나는 이미 수집과 event id의 기본 단위이므로 레코드를 단위로 삼았습니다.

## More Information

- 관련 ADR: [Run the Client Adapter Daemon and the Main Server in one Bun process](2026-10-29-run-daemon-and-main-server-in-one-bun-process.md), [Keep Session Log Events as the source data and derive the activity model](2026-10-28-keep-session-log-events-as-source-and-derive-activity-model.md)
- 다시 검토할 조건: Transport Unit마다 트랜잭션을 쓰는 비용 때문에 수집이 에이전트의 기록 속도를 따라가지 못할 때
- 용어: [Glossary](../docs/model/GLOSSARY.md)
