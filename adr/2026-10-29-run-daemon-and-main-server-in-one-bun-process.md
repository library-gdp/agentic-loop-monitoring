---
status: accepted
date: 2026-10-29
decision-makers: pgd
---

# Run the Client Adapter Daemon and the Main Server in one Bun process

## Context and Problem Statement

[Implement the Client Adapter Daemon and Plugins in TypeScript](2026-10-22-implement-daemon-and-plugins-in-typescript.md)는 Daemon을 TypeScript로 구현하기로 했지만, TypeScript를 실행할 런타임과 Main Server의 구현 언어는 정하지 않았습니다. 구현을 시작하려면 이것을 정해야 합니다.

이 애플리케이션을 실제로 쓰려는 환경에서 가장 부족한 자원은 메모리입니다. Daemon과 Main Server를 따로 구동하면 런타임의 기본 메모리를 두 번 쓰고, 프로세스 사이에서 Session Log Event를 직렬화하고 다시 해석하면서 같은 내용의 사본이 양쪽에 생깁니다.

## Decision Drivers

- **메모리 사용량을 최소화합니다.** 다른 기준보다 우선합니다.
- Daemon은 에이전트를 실행하는 사용자 계정마다 상주합니다([Client Adapter Daemon 구현](../docs/implementation/016.CLIENT_ADAPTER_DAEMON.md#실행)). 늘 떠 있는 메모리가 작아야 합니다.
- Daemon과 Main Server가 함께 쓰는 Session Log Event, Transport Unit, Ack의 타입이 어긋나지 않아야 합니다.

## Decision

- **Main Server를 TypeScript로 구현합니다.** Main Server의 모든 모듈(Input Adapter, Core, Persistence, Visualization)이 대상입니다. 모듈 구성은 [Application Architecture](../docs/model/006.APPLICATION_ARCHITECTURE.md)를 따릅니다.
- **런타임은 Bun입니다.** Daemon, Plugin, Main Server가 모두 Bun에서 실행됩니다.
- **HTTP 프레임워크는 Hono입니다.** Visualization과 원격 Transport(REST API, Streamable HTTP, WebSocket)의 HTTP 처리를 Hono로 구현하고 `Bun.serve`로 띄웁니다.
- **Daemon과 Main Server를 하나의 프로세스로 구동합니다.** 둘 사이의 Transport는 같은 프로세스 안의 함수 호출입니다([Transport](../docs/implementation/010.TRANSPORT.md#프로세스-내-호출)). Transport Unit을 직렬화하지 않고 객체 그대로 넘깁니다.
- **SQLite는 Bun에 내장된 `bun:sqlite`로 접근합니다.**
- 실행 파일은 `bun build --compile`로 하나만 만듭니다. Daemon과 Main Server가 이 실행 파일에 들어 있습니다. Plugin은 [Load built Plugins into the Daemon at runtime](2026-10-29-load-built-plugins-into-daemon-at-runtime.md)에 따라 따로 빌드하고, Daemon이 시작할 때 Plugin 디렉터리에서 같은 프로세스로 불러옵니다.

Daemon과 Main Server의 모듈 경계는 그대로 둡니다. Daemon은 Main Server를 Transport로만 부르고, Main Server의 내부 모듈을 직접 부르지 않습니다.

**범위 밖**

- 원격 Main Server를 쓸 때 Main Server만 따로 구동하는 실행 방식
- Daemon을 시작하고 상주시키는 방식(예: systemd user service, launchd)
- 코드 디렉터리 구성

## Consequences

- Good, because 런타임의 기본 메모리를 한 번만 씁니다. 대기 상태의 메모리는 약 50–80 MB로 추정하며, Daemon과 Main Server를 따로 구동하는 구성의 절반 이하입니다. 실제 값은 구현한 뒤 측정합니다.
- Good, because Transport Unit을 직렬화하지 않으므로, 큰 Session Log Event를 보낼 때 같은 내용의 사본이 생기지 않습니다.
- Good, because Daemon과 Main Server가 Session Log Event, Transport Unit, Ack의 타입 정의 하나를 함께 씁니다. 두 정의가 어긋날 일이 없습니다.
- Good, because `bun:sqlite`는 Bun에 들어 있으므로 플랫폼마다 네이티브 애드온을 빌드하거나 배포하지 않습니다.
- Bad, because Daemon과 Main Server가 메모리 상한과 이벤트 루프를 함께 씁니다. Visualization의 무거운 질의와 큰 Session Log Event의 수집이 겹치면 메모리가 함께 오르고, 메모리가 부족해 프로세스가 끝나면 수집과 시각화가 함께 멈춥니다. 에이전트는 영향을 받지 않습니다([Fail-open](../docs/model/000.SYSTEM_ARCHITECTURE.md#fail-open)).
- Bad, because `bun:sqlite`는 동기 API입니다. 큰 트랜잭션이나 무거운 질의가 도는 동안 Daemon의 수집과 Visualization의 응답이 멈춥니다.
- Bad, because Plugin은 따로 번들하므로, 여러 Plugin이 같은 라이브러리를 쓰면 그 라이브러리가 Plugin마다 메모리에 따로 올라갑니다.
- Bad, because Daemon이 사용자 계정마다 상주하므로 Main Server와 그 데이터 파일도 사용자 계정마다 하나씩 생깁니다.
- Neutral, because 원격 Transport 바인딩은 그대로 둡니다. Main Server를 원격에 두는 구성이 필요해지면 Main Server만 구동하는 실행 방식을 정합니다.

## Implementation Plan

- **Affected paths**: 아직 코드가 없습니다. 설계 문서는 다음과 같습니다.
  - [`docs/implementation/008.TECH_STACK.md`](../docs/implementation/008.TECH_STACK.md): 구현 언어, 런타임, 프레임워크, 실행 구성
  - [`docs/implementation/016.CLIENT_ADAPTER_DAEMON.md`](../docs/implementation/016.CLIENT_ADAPTER_DAEMON.md): Main Server와 한 프로세스로 실행
  - [`docs/implementation/010.TRANSPORT.md`](../docs/implementation/010.TRANSPORT.md): 프로세스 내 호출 바인딩
  - [`docs/implementation/017.DATA_STORAGE.md`](../docs/implementation/017.DATA_STORAGE.md): SQLite 라이브러리
- **Dependencies**: Bun, Hono
- **Patterns to follow**:
  - Session Log Event, Transport Unit, Ack의 타입은 한 곳에 두고 Daemon, Plugin, Main Server가 모두 그 타입만 참조합니다.
  - Daemon은 Main Server의 Input Adapter를 Transport로만 부릅니다.
  - Bun과 Web 표준 API(`fetch`, `Request`, `Response`)를 먼저 쓰고, Node.js 전용 API는 대안이 없을 때만 씁니다.
- **Patterns to avoid**:
  - Daemon이나 Plugin에서 Main Server의 Core, Persistence를 직접 부르지 않습니다.
  - Transport Unit을 같은 프로세스 안에서 JSON으로 직렬화해 넘기지 않습니다.
  - 메모리 사용량이 큰 프레임워크나 라이브러리를 더하지 않습니다. 더해야 하면 대기 상태 메모리의 변화를 측정합니다.

### Verification

- [ ] 실행 파일 하나를 실행하면 Daemon과 Main Server가 한 프로세스에서 동작하고, Plugin 디렉터리의 Plugin을 불러와 수집한 Session Log Event가 저장되어 Visualization에 보입니다.
- [ ] Daemon과 Plugin 소스에 Main Server의 Core나 Persistence를 직접 부르는 코드가 없습니다.
- [ ] 대기 상태의 RSS를 측정해 기록합니다.

## Alternatives Considered

- **Daemon과 Main Server를 따로 구동**: Main Server를 Daemon과 같은 머신의 다른 프로세스나 원격에서 실행합니다. 런타임의 기본 메모리를 두 번 쓰고 프로세스 사이에서 Session Log Event를 직렬화하므로, 메모리를 우선하는 이번 결정과 맞지 않아 기각했습니다.
- **Node.js 런타임**: 생태계가 가장 넓지만, 대기 상태의 메모리가 Bun보다 큽니다. 실행 파일 하나로 만들려면 별도의 단일 실행 파일 빌드가 필요하고, SQLite에 네이티브 애드온을 쓰면 플랫폼마다 바이너리를 배포해야 합니다.
- **Deno 런타임**: 단일 실행 파일 빌드를 지원하지만, 대기 상태의 메모리가 Bun보다 큽니다.
- **NestJS**: 구조를 잡아 주지만, 의존성 주입과 데코레이터 메타데이터 때문에 메모리가 수십 MB 더 듭니다.
- **Express, Fastify**: Node.js의 HTTP API를 기준으로 만들어졌습니다. Hono는 Web 표준 API 위에서 동작해 `Bun.serve`에 그대로 붙고 의존성이 없습니다.

## More Information

- 관련 ADR: [Implement the Client Adapter Daemon and Plugins in TypeScript](2026-10-22-implement-daemon-and-plugins-in-typescript.md), [Split the system into a Client Adapter Daemon and a Main Server](2026-10-19-split-system-into-client-adapter-daemon-and-main-server.md), [Store Main Server data in SQLite](2026-10-28-store-main-server-data-in-sqlite.md), [Send Session Log Events one record per Transport Unit](2026-10-29-send-session-log-events-one-record-per-transport-unit.md)
- 다시 검토할 조건: Main Server를 원격에 두어 여러 머신의 Daemon이 데이터를 모아야 할 때, 또는 Bun에서 메모리 사용량이 기대보다 클 때
- 용어: [Glossary](../docs/model/001.GLOSSARY.md)
