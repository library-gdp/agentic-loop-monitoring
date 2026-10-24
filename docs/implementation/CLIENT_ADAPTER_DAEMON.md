# CLIENT_ADAPTER_DAEMON.md

이 문서는 [Client Adapter Daemon](../model/CLIENT_ADAPTER_DAEMON.md)(이하 Daemon)을 구현하는 방안을 정합니다. Daemon의 동작과 규칙은 model 문서를 따르며, 이 문서는 바꾸지 않습니다. 구현 언어는 [Tech Stack](TECH_STACK.md)을, Plugin의 구현은 [Plugin Guide](PLUGIN_GUIDE.md)를 참고하세요. 용어는 [Glossary](../model/GLOSSARY.md)를 따릅니다.

## 실행

Daemon은 에이전트를 실행하는 사용자 계정마다 하나씩 상주합니다. 에이전트는 Session Log를 보통 사용자의 홈 디렉터리 아래에 파일로 기록하므로, Daemon은 그 사용자의 권한으로 실행합니다.

- 같은 상태 디렉터리를 쓰는 다른 Daemon이 이미 실행 중이면 시작하지 않고 종료합니다.

## 설정

[Client Adapter Daemon의 설정](../model/CLIENT_ADAPTER_DAEMON.md#설정)에 더해 다음 항목을 둡니다.

| 항목 | 설명 |
|---|---|
| 상태 디렉터리 | Daemon 로그 등 Daemon이 쓰는 파일을 두는 디렉터리입니다. |
| Transport | 표준입출력이면 실행할 Main Server 명령입니다. Transport별 주소는 [Transport](TRANSPORT.md#transport-바인딩)를 참고하세요. |

## 결정되지 않은 사항

- TypeScript를 실행할 런타임과 Daemon을 실행 파일 하나로 빌드하는 방법
- Daemon을 시작하고 상주시키는 방식(예: systemd user service, launchd)
- 상태 디렉터리의 기본 위치
- Ack 타임아웃, 재시도 횟수, Batch 크기 한도의 기본값
