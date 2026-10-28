---
status: proposed
date: 2026-10-28
decision-makers: pgd
---

# Store Main Server data in SQLite

## Context and Problem Statement

[Keep Session Log Events as the source data and derive the activity model](2026-10-28-keep-session-log-events-as-source-and-derive-activity-model.md)는 Main Server의 데이터를 원본 데이터와 파생 데이터로 나누고, Batch 하나를 원자적으로 저장하도록 정했습니다. Persistence를 구현하려면 이 데이터를 담을 저장소를 정해야 합니다.

## Decision Drivers

- **실행 위치가 정해지지 않았습니다.** Main Server는 Daemon과 같은 머신에서 실행될 수도 있고 원격에서 실행될 수도 있습니다. 표준입출력 Transport에서는 Daemon이 Main Server를 자식 프로세스로 띄웁니다([Transport](../docs/implementation/TRANSPORT.md#표준입출력)). 따로 띄워야 하는 데이터베이스 서버가 있으면 이 방식을 쓸 수 없습니다.
- **사용 범위는 작성자 본인에서 시작합니다**([Intent](../intent/INTENT-1.0.md#사용자)). 설치하고 운영할 것이 적어야 합니다. 팀 단계에서는 여러 Daemon이 Main Server 하나에 보냅니다.
- **Batch 하나를 원자적으로 저장해야 합니다.** 여러 레코드를 한 트랜잭션으로 쓰고, 고유 키로 중복을 걸러야 합니다.
- **여러 프로세스가 같은 데이터를 읽을 수 있어야 합니다.** 표준입출력으로 띄운 Main Server와 Visualization을 제공하는 Main Server가 다른 프로세스일 수 있습니다.
- **Kotlin의 컴파일 대상을 아직 정하지 않았습니다**([Implement the Main Server in Kotlin](2026-10-24-implement-main-server-in-kotlin.md)). 특정 런타임에만 있는 저장소는 그 선택을 미리 묶습니다.
- 쓰기는 작은 트랜잭션이 자주 일어나고, 읽기는 한 Session 안의 범위 질의가 대부분입니다. 여러 Session에 걸친 대규모 집계는 범위 밖입니다(에이전트 사이의 성능 비교, 비용 계산).

## Considered Options

- SQLite
- PostgreSQL
- JVM 임베디드 데이터베이스(H2 등)
- DuckDB
- Session마다 파일(JSONL 등)

## Decision Outcome

Chosen option: "SQLite", because 따로 띄울 서버 없이 파일 하나로 동작해 모든 실행 위치와 Transport에서 쓸 수 있고, 트랜잭션과 고유 키로 원자적 저장과 중복 제거를 그대로 지원하며, WAL 모드에서 여러 프로세스가 같은 파일을 읽을 수 있기 때문입니다. JVM과 Native 모두에서 쓸 수 있어 Kotlin의 컴파일 대상도 묶지 않습니다.

물리 스키마와 설정은 [Data Storage](../docs/implementation/DATA_STORAGE.md)가 정합니다.

**범위 밖**

- SQLite에 접근하는 라이브러리. Kotlin의 컴파일 대상과 함께 정합니다.
- 팀 단계에서 다른 저장소를 더할지 여부

### Consequences

- Good, because Main Server 실행 파일과 데이터 파일 하나만 있으면 됩니다. 표준입출력 Transport로 Daemon이 Main Server를 띄우는 구성에서도 동작합니다.
- Good, because Batch 하나를 트랜잭션 하나로 저장하고 `ON CONFLICT DO NOTHING`으로 중복을 거를 수 있습니다.
- Good, because 데이터 파일을 복사하면 백업하거나 다른 머신으로 옮길 수 있습니다.
- Bad, because 쓰기는 한 번에 하나뿐입니다. 팀 단계에서 많은 Daemon이 동시에 보내면 잠금을 기다리다 `unavailable`이 늘 수 있습니다. 이 거절은 재시도할 수 있으므로 유실로 이어지지는 않습니다.
- Bad, because 데이터 파일을 네트워크 파일 시스템에 두면 잠금이 믿을 만하지 않습니다. 데이터 파일은 Main Server와 같은 머신의 로컬 디스크에 둬야 합니다.
- Neutral, because Persistence는 Repository API 뒤에 있으므로, 팀 단계에서 다른 저장소가 필요해지면 Core를 바꾸지 않고 Persistence 구현을 더할 수 있습니다.

## Implementation Plan

- **Affected paths**: 아직 코드가 없습니다. 설계 문서는 다음과 같습니다.
  - [`docs/implementation/DATA_STORAGE.md`](../docs/implementation/DATA_STORAGE.md): 새 문서
  - [`docs/implementation/TECH_STACK.md`](../docs/implementation/TECH_STACK.md): 저장소 추가
- **Dependencies**: SQLite 드라이버. 라이브러리는 Kotlin 컴파일 대상과 함께 정합니다.
- **Patterns to follow**:
  - SQLite에 접근하는 코드는 Persistence 모듈 안에만 둡니다.
  - Batch 하나는 `BEGIN IMMEDIATE` 트랜잭션 하나로 처리하고, `COMMIT`이 끝난 뒤에만 `accepted`를 돌려줍니다.
- **Patterns to avoid**:
  - Core, Input Adapter, Visualization에서 SQL을 쓰거나 SQLite 타입을 다루지 않습니다.
  - `synchronous`를 `FULL`보다 낮추지 않습니다. `accepted`를 보낸 Batch를 잃을 수 있습니다.
- **Configuration**: 데이터 파일 경로, 쓰기 잠금 대기 시간
- **Migration steps**: 없음(새 저장소)

### Verification

- [ ] Main Server를 데이터 파일 경로만 설정해 실행하면, 다른 프로세스 없이 Batch를 받아 저장합니다.
- [ ] Batch 처리 중에 프로세스를 강제로 끝내도, 다시 시작한 뒤 그 Batch의 데이터가 전부 있거나 전부 없습니다.
- [ ] Main Server 소스에서 SQLite를 참조하는 코드가 Persistence 모듈 밖에 없습니다.
- [ ] Batch를 쓰는 동안 다른 프로세스가 같은 데이터 파일을 읽을 수 있습니다.

## Pros and Cons of the Options

### PostgreSQL

- Good, because 여러 쓰기를 동시에 처리하고 팀 서버 운영에 익숙한 선택입니다.
- Good, because JSON 원문을 질의하는 기능이 풍부합니다.
- Bad, because 따로 설치하고 띄워야 하는 서버입니다. 작성자 본인이 쓰는 첫 단계와 표준입출력 Transport에서 부담이 큽니다.

### JVM 임베디드 데이터베이스(H2 등)

- Good, because 따로 띄울 서버가 없습니다.
- Bad, because JVM에서만 쓸 수 있어 Kotlin 컴파일 대상을 JVM으로 묶습니다.
- Bad, because 임베디드 모드에서는 보통 한 프로세스만 파일을 엽니다.

### DuckDB

- Good, because 따로 띄울 서버가 없고 집계 질의가 빠릅니다.
- Bad, because 작은 트랜잭션을 자주 쓰는 데 맞지 않고, 여러 프로세스가 한 파일에 쓰기 위해 열 수 없습니다. 이 프로젝트의 질의는 Session 안의 범위 질의가 대부분이라 집계 성능의 이점이 작습니다.

### Session마다 파일

- Good, because 가장 단순하고 원문을 그대로 볼 수 있습니다.
- Bad, because 여러 파일에 걸친 원자적 쓰기, event id 중복 제거, 파생 데이터의 색인을 직접 구현해야 합니다.

## More Information

- 다시 볼 조건: 팀 단계에서 잠금 대기로 인한 `unavailable`이 자주 생길 때, 또는 Main Server를 여러 대로 늘려야 할 때
