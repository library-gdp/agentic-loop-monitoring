# TECH_STACK.md

이 문서는 시스템의 각 구성 요소를 구현하는 기술 스택을 정합니다. 구성 요소는 [System Architecture](../model/SYSTEM_ARCHITECTURE.md)를, 용어는 [Glossary](../model/GLOSSARY.md)를 따릅니다.

기술 스택을 고르는 첫 번째 기준은 메모리 사용량입니다. 이 애플리케이션을 쓰려는 환경에서 가장 부족한 자원이 메모리이기 때문입니다.

## 구현 언어

| 구성 요소 | 구현 언어 | 이유 |
|---|---|---|
| Client Adapter Daemon, Plugin | TypeScript | [Implement the Client Adapter Daemon and Plugins in TypeScript](../../adr/2026-10-22-implement-daemon-and-plugins-in-typescript.md)를 참고하세요. |
| Main Server | TypeScript | Daemon과 한 프로세스로 구동해 메모리를 줄이고, Session Log Event, Transport Unit, Ack의 타입 정의 하나를 함께 쓰기 위해서입니다. [Run the Client Adapter Daemon and the Main Server in one Bun process](../../adr/2026-10-29-run-daemon-and-main-server-in-one-bun-process.md)를 참고하세요. |

## 런타임과 프레임워크

| 항목 | 선택 | 이유 |
|---|---|---|
| 런타임 | Bun | 대기 상태의 메모리가 Node.js, Deno보다 적고, `bun build --compile`로 실행 파일 하나를 만들 수 있습니다. |
| HTTP 프레임워크 | Hono | 의존성이 없는 경량 프레임워크이며 Web 표준 API 위에서 동작해 `Bun.serve`에 그대로 붙습니다. Visualization과 HTTP를 쓰는 Transport(REST API, Streamable HTTP, WebSocket)에 씁니다. |

결정 배경은 [Run the Client Adapter Daemon and the Main Server in one Bun process](../../adr/2026-10-29-run-daemon-and-main-server-in-one-bun-process.md)를 참고하세요.

## 실행 구성

Daemon과 Main Server를 하나의 프로세스로 구동합니다. 실행 파일은 하나이며, Daemon, Plugin, Main Server가 모두 들어 있습니다.

- Daemon과 Main Server 사이의 Transport는 [프로세스 내 호출](TRANSPORT.md#프로세스-내-호출)입니다. Transport Unit을 직렬화하지 않고 객체 그대로 넘깁니다.
- Daemon은 Main Server를 Transport로만 부르며, Main Server의 Core나 Persistence를 직접 부르지 않습니다.
- Daemon이 사용자 계정마다 하나씩 상주하므로([Client Adapter Daemon 구현](CLIENT_ADAPTER_DAEMON.md#실행)), Main Server와 그 데이터 파일도 사용자 계정마다 하나입니다.

## 저장소

| 구성 요소 | 저장소 | 이유 |
|---|---|---|
| Main Server | SQLite | 따로 띄울 서버 없이 파일 하나로 동작해 Main Server의 모든 실행 위치와 Transport에서 쓸 수 있습니다. [Store Main Server data in SQLite](../../adr/2026-10-28-store-main-server-data-in-sqlite.md)를 참고하세요. 테이블은 [Table Definition](TABLE_DEFINITION.md)에서 정합니다. |

SQLite에는 Bun에 내장된 `bun:sqlite`로 접근합니다([Data Storage](DATA_STORAGE.md) 참고).
