# CLIENT_ADAPTER_DAEMON.md

이 문서는 [Client Adapter Daemon](../model/CLIENT_ADAPTER_DAEMON.md)(이하 Daemon)과 [Plugin](../model/PLUGIN_SPEC.md)을 구현하는 방안을 정합니다. Daemon과 Plugin의 동작과 규칙은 model 문서를 따르며, 이 문서는 바꾸지 않습니다. 용어는 [Glossary](../model/GLOSSARY.md)를 따릅니다.

## 구현 언어

Daemon과 Plugin은 TypeScript로 구현합니다([Implement the Client Adapter Daemon and Plugins in TypeScript](../../adr/2026-10-22-implement-daemon-and-plugins-in-typescript.md)).

## Plugin을 Daemon에 넣는 방식

Plugin 코드는 Daemon 실행 파일에 함께 빌드합니다. Daemon은 실행 중에 Plugin을 불러오지 않으며, Daemon 설정의 "사용할 Plugin"은 실행 파일에 들어 있는 Plugin 가운데 활성화할 것을 고릅니다. 새 에이전트를 지원하거나 Plugin을 고치면 Daemon을 다시 빌드하고 배포합니다. 결정 배경은 [Bundle Plugins into the Client Adapter Daemon executable](../../adr/2026-10-22-bundle-plugins-into-daemon-executable.md)을 참고하세요.

## 실행

Daemon은 에이전트를 실행하는 사용자 계정마다 하나씩 상주합니다. Session Log File은 보통 사용자의 홈 디렉터리 아래에 있으므로, Daemon은 그 사용자의 권한으로 실행합니다.

- 같은 상태 디렉터리를 쓰는 다른 Daemon이 이미 실행 중이면 시작하지 않고 종료합니다.

## 설정

[Client Adapter Daemon의 설정](../model/CLIENT_ADAPTER_DAEMON.md#설정)에 더해 다음 항목을 둡니다.

| 항목 | 설명 |
|---|---|
| 상태 디렉터리 | Daemon 로그 등 Daemon이 쓰는 파일을 두는 디렉터리입니다. |
| Transport | 표준입출력이면 실행할 Main Server 명령입니다. Transport별 주소는 [Agent Logging Protocol 구현](AGENT_LOGGING_PROTOCOL.md#transport-바인딩)을 참고하세요. |

## 에이전트별 Plugin 문서

Plugin을 구현할 때 에이전트마다 따로 문서를 만들고 다음을 적습니다.

- **Trigger**: [Trigger](../model/PLUGIN_SPEC.md#trigger)에서 Plugin이 정의하는 것
- **읽는 방식**: [읽는 방식](../model/PLUGIN_SPEC.md#읽는-방식)에서 Plugin이 정의하는 것
- **Session Log File**: 위치와 형식
- **변환**: 레코드를 Session Log Event로 옮기는 방법과, [Turn 단위](../model/PLUGIN_SPEC.md#turn-단위)의 세 기준을 알아보는 방법
- **input 기록 범위**: LLM Call의 input([Glossary](../model/GLOSSARY.md) 참고) 가운데 그 에이전트가 Session Log File에 기록하는 것과 기록하지 않는 것. 기록하지 않는 input은 Plugin이 만들어 내지 않습니다.

## 결정되지 않은 사항

- TypeScript를 실행할 런타임과 Daemon을 실행 파일 하나로 빌드하는 방법
- Plugin이 Session Log Event를 Daemon에 넘기는 TypeScript 인터페이스
- Plugin이 읽은 위치 같은 자신의 상태를 저장하는 위치
- Daemon을 시작하고 상주시키는 방식(예: systemd user service, launchd)
- 상태 디렉터리의 기본 위치
- Ack 타임아웃, 재시도 횟수, Batch 크기 한도의 기본값
