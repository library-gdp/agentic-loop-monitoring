---
status: accepted
date: 2026-10-29
decision-makers: pgd
---

# Send Session Log Events one record per Transport Unit

## Context and Problem Statement

Client Adapter Daemon과 Main Server 사이에서 Session Log Event를 주고받는 단위와, Main Server가 그것을 언제 저장하는지를 정해야 합니다. 이 단위가 크면 Daemon과 Main Server가 그 단위 전체를 메모리에 올려 두어야 합니다. 끝난 Turn 하나를 한 번에 보내면, 큰 도구 결과가 많은 Turn에서 이 크기가 수십 MB가 될 수 있습니다. 또 Turn이 끝날 때까지 기다렸다 보내면, 진행 중인 Turn은 Main Server에 보이지 않고 에이전트가 충돌로 종료되면 그 Turn을 잃습니다.

[Run the Client Adapter Daemon and the Main Server in one Bun process](2026-10-29-run-daemon-and-main-server-in-one-bun-process.md)는 메모리 사용량을 다른 기준보다 우선합니다. Daemon과 Main Server가 한 프로세스에서 메모리를 함께 쓰므로, 한 번에 다루는 데이터의 크기가 곧 프로세스의 최대 메모리를 정합니다.

## Decision

Daemon과 Main Server 사이의 데이터 송수신 단위를 **Transport Unit**이라고 부르고, Transport Unit 하나에 **Session Log의 레코드 하나**에서 나온 Session Log Event를 담습니다. Main Server는 Turn 단위로 모으지 않고 **Transport Unit을 받는 대로 저장**합니다.

- Plugin은 Turn이 끝나기를 기다리지 않습니다. 완결된 레코드를 Session Log Event로 변환하는 대로 Transport Unit 하나로 Daemon에 넘깁니다. Session Log Event가 나오지 않는 레코드는 넘기지 않습니다.
- Daemon은 Transport Unit을 합치거나 나누지 않고, 하나씩 보내고 Ack를 기다립니다.
- Plugin은 Turn을 나누고, Transport Unit에 Turn 정보를 싣습니다.
  - `turn.id`: Turn을 시작한 `user_message`의 `event_id`
  - `turn.position`: `events`의 첫 Session Log Event의 Turn 안 위치
- 사용자가 중단한 Turn도 남깁니다. Plugin은 사용자 중단을 기록한 레코드를 새 Session Log Event 종류인 `turn_interrupted`로 넘깁니다.
- Turn이 어떻게 끝났는지는 Core가 저장된 Session Log Event로 판단합니다. Turn의 `status`는 `completed`(최종 응답), `interrupted`(`turn_interrupted`), `errored`(최종 응답도 중단도 없이 같은 Agent의 다음 Turn이 시작됨), `in_progress`(그 밖) 가운데 하나입니다.
- Main Server는 Transport Unit 하나를 원자적으로 저장하고, 그 Transport Unit이 속한 Turn의 파생 데이터를 다시 만든 뒤 `accepted`를 돌려줍니다. 새로 저장한 Session Log Event가 있으면 같은 Agent의 `in_progress`인 다른 Turn은 `errored`가 됩니다.
- Plugin은 송수신 단위를 정의하지 않습니다. 단위는 모든 Plugin에서 레코드 하나입니다.

**범위 밖**

- 레코드 하나가 아주 클 때 Main Server가 받아들이는 Transport Unit 크기의 상한
- 여러 Transport Unit을 하나의 트랜잭션으로 모아 쓰는 최적화
- Visualization이 `interrupted`, `in_progress` Turn을 보여 주는 방식

## Consequences

- Good, because Daemon과 Main Server가 한 번에 다루는 데이터가 레코드 하나 크기로 제한됩니다. 최대 메모리가 Turn의 크기에 따라 커지지 않습니다.
- Good, because Plugin이 Turn 전체를 메모리에 모아 두거나 Turn이 끝났는지 미리 읽어 볼 필요가 없습니다. 진행 중인 Turn의 `turn.id`와 다음 위치만 기억합니다.
- Good, because 진행 중인 Turn이 곧바로 Main Server에 보입니다. 에이전트가 충돌로 종료되어도 그때까지 기록된 레코드는 남습니다.
- Good, because 사용자가 중단한 Turn도 남으므로, 사람이 작업을 멈춘 지점도 실패 판단의 단서로 역추적할 수 있습니다.
- Good, because Plugin마다 송수신 단위를 정의하고 문서화할 필요가 없습니다.
- Bad, because Transport Unit 수와 트랜잭션 수가 레코드 수만큼 늘어납니다. `synchronous=FULL`에서는 Transport Unit마다 디스크 동기화가 일어나므로 처리량이 줄어듭니다.
- Bad, because Turn의 일부만 저장된 상태가 늘 있습니다. 에이전트가 충돌로 종료되어 Session이 끝나면 그 Turn은 `in_progress`로 남습니다.
- Bad, because `errored`인지 판단하려면 같은 Agent의 다른 Turn을 봐야 합니다. Turn의 파생 데이터가 그 Turn의 Session Log Event만으로 정해지지 않습니다.
- Bad, because Transport Unit마다 그 Turn의 파생 데이터를 다시 만들므로, Turn 하나를 저장하는 비용이 Turn의 레코드 수의 제곱에 비례합니다. 느려지면 파생 데이터를 바뀐 부분만 고치는 방식으로 바꿉니다.
- Bad, because 사용자가 중단한 Turn을 기록하지 않던 원칙이 바뀝니다. 중단한 Turn의 프롬프트와 도구 결과도 저장됩니다.

## Implementation Plan

- **Affected paths**: 아직 코드가 없습니다. 설계 문서는 다음과 같습니다.
  - [`docs/model/003.AGENT_LOGGING_PROTOCOL.md`](../docs/model/003.AGENT_LOGGING_PROTOCOL.md): Transport Unit과 Ack의 필드
  - [`docs/model/004.PLUGIN_SPEC.md`](../docs/model/004.PLUGIN_SPEC.md): Trigger, 수집, Turn 단위, Transport Unit을 넘기는 규칙
  - [`docs/model/005.CLIENT_ADAPTER_DAEMON.md`](../docs/model/005.CLIENT_ADAPTER_DAEMON.md): Transport Unit 전송과 Ack 처리
  - [`docs/model/002.DOMAIN_MODEL.md`](../docs/model/002.DOMAIN_MODEL.md): `turn_interrupted`, Turn 구성 규칙과 `status`
  - [`docs/model/007.DATA_ARCHITECTURE.md`](../docs/model/007.DATA_ARCHITECTURE.md): 수신 기록, 쓰기 절차
  - [`docs/model/000.SYSTEM_ARCHITECTURE.md`](../docs/model/000.SYSTEM_ARCHITECTURE.md): 데이터 흐름, 전달 보장
  - [`docs/implementation/018.TABLE_DEFINITION.md`](../docs/implementation/018.TABLE_DEFINITION.md), [`docs/implementation/017.DATA_STORAGE.md`](../docs/implementation/017.DATA_STORAGE.md), [`docs/implementation/009.MESSAGE_CONVENTION.md`](../docs/implementation/009.MESSAGE_CONVENTION.md), [`docs/implementation/010.TRANSPORT.md`](../docs/implementation/010.TRANSPORT.md), [`docs/implementation/011.PLUGIN_GUIDE.md`](../docs/implementation/011.PLUGIN_GUIDE.md)
- **Dependencies**: 없음
- **Patterns to follow**:
  - Plugin은 레코드를 하나씩 읽고 변환해 곧바로 넘기며, Turn의 Session Log Event를 메모리에 모아 두지 않습니다.
  - Main Server의 Session Log Event의 소속 Turn과 위치는 Transport Unit의 `turn` 필드로만 정합니다.
  - `errored`인지는 Session Log Event를 처음 저장한 순서로 판단하며, 다시 받아 건너뛴 Session Log Event로 판단하지 않습니다.
- **Patterns to avoid**:
  - Plugin이 Turn이 끝나기를 기다렸다가 넘기지 않습니다.
  - Daemon이 여러 Transport Unit을 합쳐 보내지 않습니다.
  - Main Server가 Transport Unit이 도착한 순서로 Turn 안 위치를 정하지 않습니다.

### Verification

- [ ] 모든 Transport Unit의 `events`가 Session Log의 레코드 하나에서 나옵니다.
- [ ] 에이전트가 레코드를 기록하면, 그 Turn이 끝나기 전에 그 레코드의 Session Log Event가 Main Server에 저장됩니다.
- [ ] 같은 Transport Unit을 두 번 받아도 원본 데이터와 파생 데이터가 한 번 받은 것과 같습니다.
- [ ] 사용자가 중단한 Turn이 `interrupted`로 저장됩니다.
- [ ] 최종 응답 없이 다음 Turn이 시작되면 앞 Turn이 `errored`가 되고, 앞선 Turn을 다시 보내도 진행 중인 Turn은 `in_progress`로 남습니다.

## Alternatives Considered

- **끝난 Turn 하나 이상을 한 번에 보내기**: Main Server가 Turn을 한 번에 받으므로 Turn의 일부만 저장된 상태가 없고 트랜잭션 수가 적습니다. 하지만 최대 메모리가 가장 큰 Turn의 크기에 따라 커지고, 진행 중인 Turn이 보이지 않으며, 충돌로 끝난 마지막 Turn을 잃습니다. 메모리를 우선하고 받는 대로 저장하기로 했으므로 기각했습니다.
- **레코드 하나씩 보내되 Turn이 끝난 뒤에 보내기**: 메모리는 레코드 하나로 제한되지만, Plugin이 Turn의 끝을 확인할 때까지 보내지 못하므로 진행 중인 Turn이 보이지 않습니다. 받는 대로 저장하는 결정과 맞지 않아 기각했습니다.
- **Session Log Event 하나씩 보내기**: 단위가 가장 작지만, 레코드 하나에서 나온 Session Log Event들이 나뉘어 저장되고 Transport Unit 수가 더 늘어납니다. 레코드 하나는 이미 수집과 event id의 기본 단위이므로 레코드를 단위로 삼았습니다.
- **사용자가 중단한 Turn을 지우기**: 중단이 확인되면 그 Turn의 Session Log Event를 지웁니다. 원본 데이터는 추가만 하고 Session 단위로만 지운다는 원칙을 깨고, 중단도 실패 판단의 단서이므로 기각했습니다.
- **사용자가 중단한 Turn을 원문에만 남기고 활동 모델에서 빼기**: 저장은 하지만 역추적할 때 보이지 않으므로 기각했습니다.

## More Information

- 관련 ADR: [Run the Client Adapter Daemon and the Main Server in one Bun process](2026-10-29-run-daemon-and-main-server-in-one-bun-process.md), [Keep Session Log Events as the source data and derive the activity model](2026-10-28-keep-session-log-events-as-source-and-derive-activity-model.md)
- 다시 검토할 조건: Transport Unit마다 트랜잭션을 쓰는 비용 때문에 수집이 에이전트의 기록 속도를 따라가지 못할 때
- 용어: [Glossary](../docs/model/001.GLOSSARY.md)
