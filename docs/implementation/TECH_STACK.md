# TECH_STACK.md

이 문서는 시스템의 각 구성 요소를 구현하는 기술 스택을 정합니다. 구성 요소는 [System Architecture](../model/SYSTEM_ARCHITECTURE.md)를, 용어는 [Glossary](../model/GLOSSARY.md)를 따릅니다.

## 구현 언어

| 구성 요소 | 구현 언어 | 이유 |
|---|---|---|
| Client Adapter Daemon, Plugin | TypeScript | [Implement the Client Adapter Daemon and Plugins in TypeScript](../../adr/2026-10-22-implement-daemon-and-plugins-in-typescript.md)를 참고하세요. |
| Main Server | Kotlin | 크로스 플랫폼으로 실행하기 위해서입니다. Main Server를 빌드하는 환경과 구동하는 환경이 다를 수 있습니다. [Implement the Main Server in Kotlin](../../adr/2026-10-24-implement-main-server-in-kotlin.md)을 참고하세요. |

## 저장소

| 구성 요소 | 저장소 | 이유 |
|---|---|---|
| Main Server | SQLite | 따로 띄울 서버 없이 파일 하나로 동작해 Main Server의 모든 실행 위치와 Transport에서 쓸 수 있습니다. [Store Main Server data in SQLite](../../adr/2026-10-28-store-main-server-data-in-sqlite.md)를 참고하세요. 스키마는 [Data Storage](DATA_STORAGE.md)에서 정합니다. |
