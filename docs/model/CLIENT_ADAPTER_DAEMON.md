# CLIENT_ADAPTER_DAEMON.md

이 문서는 Client Adapter Daemon(이하 Daemon)의 동작을 설명합니다. 시스템 안에서 Daemon이 차지하는 위치는 [System Architecture](SYSTEM_ARCHITECTURE.md)를, 용어는 [Glossary](GLOSSARY.md)를 참고하세요.

## 구성 요소

| 구성 요소 | 역할 |
|---|---|
| Plugin | 에이전트마다 하나씩 둡니다. 자신이 정의한 Trigger와 읽는 방식에 따라 Session Log File을 읽고 Session Log Event로 변환합니다. [Plugin Specification](PLUGIN_SPEC.md)을 따릅니다. |
| Transport Client | 설정된 Transport로 Main Server에 Batch를 보내고 Ack를 받습니다. [Agent Logging Protocol](AGENT_LOGGING_PROTOCOL.md)을 따릅니다. |

## 실행

Daemon은 에이전트가 실행되는 머신에 상주합니다.

- Daemon은 시작할 때 설정에서 활성화한 Plugin을 시작합니다.
- Daemon은 Session Log File을 직접 읽지 않습니다. 언제 읽을지(Trigger)와 어떻게 읽을지는 Plugin이 정합니다([Plugin Specification](PLUGIN_SPEC.md#plugin이-정의하는-것) 참고).
- Daemon은 Plugin이 Session Log File을 어디까지 읽었는지 기록하지 않습니다. 이것도 Plugin이 맡습니다.

## Session Log Event 전송

### Batch 만들기

Plugin은 한 Session의 끝난 Turn 단위로 Session Log Event를 Daemon에 넘깁니다. Daemon은 이를 Batch로 묶습니다.

- 한 Batch에는 한 Session의 Session Log Event만 담습니다.
- Turn 하나를 여러 Batch에 나누지 않습니다.
- Batch는 Batch 크기 한도를 넘지 않습니다. 다만 Turn 하나가 한도보다 크면 그 Turn만 담아 보냅니다.

### 보내기

Daemon은 Batch를 하나씩 보냅니다. Batch를 보낸 뒤에는 Ack를 받거나 타임아웃이 날 때까지 기다리며, 그동안 다른 Batch를 보내지 않습니다. 여러 Plugin이 넘긴 Session Log Event는 넘겨받은 순서대로 보냅니다.

### Ack 처리

| 결과 | 다음 동작 |
|---|---|
| 성공 Ack | 다음 Batch를 보냅니다. |
| 재시도 가능한 실패: 연결 실패, 전송 실패, Ack 타임아웃, `retryable`이 `true`인 거절 Ack | 정해진 횟수만큼 간격을 늘려가며 같은 Batch를 다시 보냅니다. 모두 실패하면 로그를 남깁니다. |
| 재시도할 수 없는 실패: `retryable`이 `false`인 거절 Ack | 로그를 남기고 Batch를 버립니다. |

## 설정

| 항목 | 설명 |
|---|---|
| Transport | 사용할 Transport의 종류와 주소입니다. |
| Ack 타임아웃 | Batch를 보낸 뒤 Ack를 기다리는 최대 시간입니다. |
| 재시도 횟수와 간격 | 재시도 가능한 실패에서 같은 Batch를 다시 보내는 횟수와 간격입니다. |
| Batch 크기 한도 | Batch 하나에 담는 Session Log Event 수와 바이트 수의 최댓값입니다. Turn 하나가 한도보다 크면 그 Turn만 담아 보냅니다. |
| 사용할 Plugin | 활성화할 Plugin의 에이전트 id 목록입니다. |

## 로그

Daemon은 자신의 로그 파일에만 기록하며, 에이전트에는 아무것도 출력하지 않습니다. 다음 경우에는 로그를 남깁니다.

- Plugin이 레코드를 해석하지 못하고 건너뛴 경우
- 사용자가 중단한 Turn을 버린 경우
- 재시도 가능한 실패와 재시도를 모두 실패한 경우
- 재시도할 수 없는 거절로 Batch를 버린 경우

## 결정되지 않은 사항

- 재시도를 모두 실패한 Batch를 나중에 다시 보내는 방법
