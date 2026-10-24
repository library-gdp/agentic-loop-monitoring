---
status: accepted
date: 2026-10-24
decision-makers: pgd
---

# Implement the Main Server in Kotlin

## Context and Problem Statement

[Implement the Client Adapter Daemon and Plugins in TypeScript](2026-10-22-implement-daemon-and-plugins-in-typescript.md)는 Main Server의 구현 언어를 범위 밖으로 남겼습니다. Main Server를 구현하려면 이 언어를 정해야 합니다.

Main Server는 Client Adapter Daemon과 같은 머신에서 실행될 수도 있고 원격에서 실행될 수도 있습니다([System Architecture](../docs/model/SYSTEM_ARCHITECTURE.md#실행-위치와-transport) 참고). 그래서 Main Server를 빌드하는 환경과 구동하는 환경이 다를 수 있습니다.

## Decision

Main Server를 Kotlin으로 구현합니다.

- Main Server의 모든 모듈(Input Adapter, Core, Persistence, Visualization)을 Kotlin으로 구현합니다. 모듈 구성은 [Application Architecture](../docs/model/APPLICATION_ARCHITECTURE.md)를 따릅니다.

**범위 밖**

- Kotlin의 컴파일 대상(JVM 등)과 배포 형태
- 빌드 도구와 라이브러리
- 코드 디렉터리 구성

## Consequences

- Good, because 크로스 플랫폼으로 실행할 수 있어, Main Server를 빌드한 환경과 다른 환경에서도 구동할 수 있습니다.
- Bad, because Client Adapter Daemon(TypeScript)과 Main Server가 다른 언어를 씁니다. 두 프로세스가 함께 쓰는 Session Log Event와 Batch, Ack의 타입을 언어마다 따로 정의해야 하며, 두 정의가 어긋날 수 있습니다.

## Implementation Plan

- **Affected paths**: 아직 코드가 없습니다. 설계 문서는 다음과 같습니다.
  - [`docs/implementation/TECH_STACK.md`](../docs/implementation/TECH_STACK.md): Main Server의 구현 언어
- **Dependencies**: Kotlin 컴파일러. 컴파일 대상과 빌드 도구는 후속 결정으로 정합니다.
- **Patterns to follow**:
  - Session Log Event와 Batch, Ack의 Kotlin 타입은 [Domain Model](../docs/model/DOMAIN_MODEL.md)과 [Agent Logging Protocol](../docs/model/AGENT_LOGGING_PROTOCOL.md)을 기준으로 정의하고, Daemon의 TypeScript 타입을 기준으로 삼지 않습니다.
- **Patterns to avoid**:
  - 특정 운영체제에서만 동작하는 기능에 의존하지 않습니다.

### Verification

- [ ] Main Server의 모든 모듈이 Kotlin으로 구현되어 있습니다.
- [ ] Main Server를 빌드한 환경과 다른 운영체제에서 Main Server가 실행됩니다.

## Alternatives Considered

다른 언어는 따로 비교하지 않았습니다. 결정한 사람이 크로스 플랫폼을 이유로 Kotlin을 지정했습니다.

## More Information

- 관련 ADR: [Implement the Client Adapter Daemon and Plugins in TypeScript](2026-10-22-implement-daemon-and-plugins-in-typescript.md)
- 용어: [Glossary](../docs/model/GLOSSARY.md)
