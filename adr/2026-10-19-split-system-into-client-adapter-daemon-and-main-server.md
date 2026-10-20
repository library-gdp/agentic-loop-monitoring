---
status: accepted
date: 2026-10-19
decision-makers: pgd
---

# Split the system into a Client Adapter Daemon and a Main Server

## Context and Problem Statement

이 애플리케이션은 Claude Code, Codex, OpenCode 같은 AI 코딩 에이전트의 작업(LLM Call, Tool Call, Token Usage 등)을 수집하고 저장해서 시각화합니다. 수집의 원천은 두 가지입니다.

- **Hook**: 에이전트가 특정 시점에 외부 명령을 실행하게 해 주는 확장 지점입니다.
- **Session Log File**: 에이전트가 세션의 대화 내용과 LLM 호출 정보를 기록하는 파일입니다. 에이전트마다 위치와 형식이 다르며, 에이전트가 실행되는 머신의 로컬 디스크에만 있습니다.

처음 설계([Application Architecture](../docs/APPLICATION_ARCHITECTURE.md)의 이전 판)는 애플리케이션 하나가 Hook을 받고, Session Log File을 읽고, 에이전트별 Translator로 변환하고, 저장과 시각화까지 하는 구조였습니다. 하지만 데이터를 저장하고 보여주는 서버는 원격에서 실행될 수도 있어야 합니다. 원격 서버는 에이전트 머신의 Session Log File을 직접 읽을 수 없습니다. 그래서 파일을 읽는 부분과 저장하고 보여주는 부분을 다른 프로세스로 나눠야 합니다.

## Decision

시스템을 두 프로세스로 나눕니다.

- **Client Adapter Daemon**: 에이전트가 실행되는 머신에서, 에이전트를 실행하는 사용자 계정마다 하나씩 상주합니다. Stop Hook이 실행하는 Hook Client로부터 Signal을 받으면 Session Log File을 읽습니다. 읽은 레코드를 에이전트 공통 포맷인 Wire Event로 변환해 Main Server로 보냅니다.
- **Main Server**: Wire Event를 받아 Canonical Event로 변환하고 저장, 조회, 시각화합니다. Input Adapter, Core, Persistence, Visualization 모듈로 이루어집니다.

에이전트별 해석은 Client Adapter Daemon 안의 **Plugin**이 맡습니다. Plugin은 에이전트마다 하나씩 둡니다. Main Server는 Wire Event만 받으며 에이전트 종류를 알지 못합니다. 새 에이전트를 지원할 때는 Plugin만 추가하고 Main Server는 바꾸지 않습니다.

Wire Event(전송 형식)와 Canonical Event(Main Server 내부의 Core 객체)는 서로 다른 모델입니다. Main Server의 Input Adapter가 Decoder로 둘 사이를 변환합니다.

Main Server의 실행 위치는 정하지 않습니다. 같은 머신일 수도 있고 원격일 수도 있습니다. Daemon과 Main Server 사이의 Transport로 표준입출력, Unix Socket, REST API, Streamable HTTP, WebSocket을 지원합니다. 이 가운데 표준입출력과 Unix Socket은 같은 머신에서만 씁니다.

**범위 밖**

- Main Server를 어디에 배포할지
- 원격 Transport의 인증과 암호화
- 구현 언어와 Plugin을 Daemon에 넣는 방식(빌드할 때 포함 또는 실행 중 로딩)

## Consequences

- Good, because Main Server가 원격에 있어도 Session Log File을 읽을 수 있습니다. 파일은 항상 같은 머신의 Daemon이 읽습니다.
- Good, because 에이전트별 차이가 Plugin 안에 갇힙니다. Main Server는 Wire Protocol 하나만 이해하면 되고, 에이전트 형식이 바뀌어도 Main Server를 다시 배포하지 않습니다.
- Good, because 여러 머신의 Daemon이 Main Server 하나로 데이터를 보낼 수 있습니다(표준입출력 제외).
- Bad, because 프로세스 사이의 계약인 [Wire Protocol](../docs/WIRE_PROTOCOL.md)을 따로 정의하고 버전을 관리해야 합니다.
- Bad, because Plugin을 고치면 각 에이전트 머신의 Daemon을 갱신해야 합니다. Plugin 버전이 머신마다 다를 수 있으므로 Batch에 `plugin_version`을 싣습니다.
- Bad, because Main Server가 원격에 있으면 마스킹하지 않은 프롬프트와 Tool Call 결과가 네트워크로 나갑니다. 원격 Transport의 인증과 암호화를 후속 결정으로 남깁니다.

## Implementation Plan

- **Affected paths**: 아직 코드가 없습니다. 설계 문서는 다음과 같습니다.
  - [`docs/SYSTEM_ARCHITECTURE.md`](../docs/SYSTEM_ARCHITECTURE.md): 프로세스 구성과 데이터 흐름
  - [`docs/APPLICATION_ARCHITECTURE.md`](../docs/APPLICATION_ARCHITECTURE.md): Main Server 모듈 구성
  - [`docs/CLIENT_ADAPTER_DAEMON.md`](../docs/CLIENT_ADAPTER_DAEMON.md): Daemon과 Hook Client
  - [`docs/PLUGIN_SPEC.md`](../docs/PLUGIN_SPEC.md): Plugin 인터페이스
  - [`docs/WIRE_PROTOCOL.md`](../docs/WIRE_PROTOCOL.md): Daemon과 Main Server 사이의 메시지 형식
  - 코드 디렉터리 구성은 구현 언어를 정하는 ADR에서 정합니다.
- **Dependencies**: 없음
- **Patterns to follow**:
  - Daemon과 Main Server는 별도로 빌드하고 배포할 수 있는 실행 단위로 둡니다.
  - 에이전트별 형식 해석은 모두 [Plugin Specification](../docs/PLUGIN_SPEC.md)의 `resolve`와 `read` 안에서 합니다.
  - Main Server의 Input Adapter는 Wire Protocol 버전마다 Decoder를 하나씩 둡니다.
- **Patterns to avoid**:
  - Main Server 코드에서 에이전트 id에 따라 분기하지 않습니다.
  - Main Server가 Session Log File을 직접 읽지 않습니다.
  - Wire Event 타입을 Core의 Canonical Event로 그대로 재사용하지 않습니다.

### Verification

- [ ] Main Server의 소스에 에이전트별 Session Log File 형식을 해석하는 코드가 없습니다.
- [ ] Main Server가 Client Adapter Daemon과 다른 머신에서 REST API, Streamable HTTP, WebSocket 중 하나로 Batch를 받아 저장합니다.
- [ ] 새 에이전트용 Plugin을 추가할 때 Main Server의 코드를 바꾸지 않아도 그 에이전트의 Wire Event가 저장됩니다.
- [ ] Core 모듈이 Wire Protocol의 타입에 의존하지 않습니다. Wire Event를 Canonical Event로 바꾸는 코드는 Input Adapter에만 있습니다.

## Alternatives Considered

- **Daemon은 원본만 보내고 Main Server의 Translator가 해석**: 이전 설계와 같은 위치에서 변환하는 방식입니다. Daemon은 단순해지지만, Main Server가 모든 에이전트의 형식을 알아야 합니다. 그러면 에이전트 형식이 바뀔 때마다 Main Server를 다시 배포해야 하므로 기각했습니다.
- **단일 프로세스 유지**: Hook 수신부터 시각화까지 한 프로세스에서 처리하는 방식입니다. 서버를 원격에서 실행할 수 없으므로 기각했습니다.

## More Information

- 관련 ADR: [Read Session Log Files incrementally from an Ack-confirmed offset](2026-10-19-read-session-log-files-incrementally-from-acked-offset.md)
- 용어: [Glossary](../docs/GLOSSARY.md)
- 다시 검토할 조건: 에이전트가 Session Log File 없이 원격 API로만 기록을 제공하게 되는 경우
