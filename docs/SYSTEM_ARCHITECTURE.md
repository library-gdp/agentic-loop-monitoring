# SYSTEM_ARCHITECTURE.md

이 문서는 시스템을 이루는 프로세스와 그 사이의 데이터 흐름을 설명합니다. Main Server 내부의 모듈 구성은 [Application Architecture](APPLICATION_ARCHITECTURE.md)에서 다룹니다. 용어는 [Glossary](GLOSSARY.md)를 따릅니다.

## 구성

시스템은 에이전트가 실행되는 머신에서 동작하는 Client Adapter Daemon과, 데이터를 받아 저장하고 시각화하는 Main Server로 나뉩니다.

```
┌──────────────────────── Agent host ────────────────────────┐
│                                                            │
│  AI Agent ────── writes ──────▶ Session Log File           │
│     │                                  ▲                   │
│     │ Stop Hook                        │ read from Offset  │
│     ▼                                  │                   │
│  Hook Client ── Signal ──▶ Client Adapter Daemon           │
│                              ├── Plugins                   │
│                              └── Offset Store              │
│                                    │  ▲                    │
└────────────────────────────────────┼──┼────────────────────┘
                               Batch │  │ Ack   (Transport)
                                     ▼  │
┌──────────────────────── Main Server ───────────────────────┐
│                                                            │
│  Input Adapter, Core, Persistence, Visualization           │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

| 구성 요소 | 실행 위치 | 역할 |
|---|---|---|
| Hook Client | 에이전트 머신 | 에이전트의 Stop Hook이 실행합니다. Daemon에 Signal을 보내고 바로 종료합니다. |
| Client Adapter Daemon | 에이전트 머신 | 에이전트를 실행하는 사용자 계정마다 하나씩 상주합니다. Signal을 받으면 Plugin으로 Session Log File을 Offset부터 읽어 Wire Event로 변환하고, Batch로 묶어 Main Server에 보냅니다. 성공 Ack를 받으면 Offset을 갱신합니다. |
| Main Server | 정하지 않음 | Batch를 받아 Canonical Event로 바꾸고 저장, 조회, 시각화합니다. |

에이전트별 차이는 Client Adapter Daemon의 Plugin이 모두 흡수합니다. Main Server는 Wire Event만 받으므로 에이전트 종류를 알 필요가 없습니다.

세부 설계는 다음 문서에서 다룹니다.

- [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md): Hook Client, Signal, Signal 처리, Offset 관리
- [Plugin Specification](PLUGIN_SPEC.md): Plugin이 구현해야 하는 인터페이스와 규칙
- [Wire Protocol](WIRE_PROTOCOL.md): Batch, Wire Event, Ack의 형식과 Transport별 전송 방식

## 실행 위치와 Transport

Main Server가 어디서 실행되는지는 정하지 않습니다. Client Adapter Daemon과 같은 머신에서 실행될 수도 있고 원격에서 실행될 수도 있습니다. 쓸 수 있는 Transport는 실행 위치에 따라 다릅니다.

| Transport | 같은 머신 | 원격 |
|---|---|---|
| 표준입출력 | O | X |
| Unix Socket | O | X |
| REST API | O | O |
| Streamable HTTP | O | O |
| WebSocket | O | O |

표준입출력과 Unix Socket은 같은 머신의 프로세스끼리만 연결할 수 있습니다. 표준입출력은 Daemon과 Main Server를 1:1로 연결합니다. 나머지 Transport로는 여러 머신의 Daemon이 Main Server 하나에 데이터를 보낼 수 있습니다.

Hook Client와 Daemon은 항상 같은 머신에서 실행되므로, Signal은 Transport와 별개로 Unix Socket으로 주고받습니다.

## 데이터 흐름

1. 에이전트가 Turn을 마치면 Stop Hook으로 Hook Client를 실행합니다.
2. Hook Client는 Hook payload 원문을 담은 Signal을 Daemon에 보내고, 처리 결과를 기다리지 않고 종료합니다.
3. Daemon은 Signal에 적힌 에이전트의 Plugin을 고르고, Plugin은 Hook payload에서 Session Log File의 위치를 알아냅니다.
4. Daemon은 Offset Store에서 그 Session의 Offset을 꺼내고, Plugin에게서 이번에 읽을 끝 위치를 받습니다. Plugin은 Offset부터 끝 위치까지 파일을 읽어, 끝난 Turn 단위로 Wire Event로 변환합니다. 사용자가 중단한 Turn은 버리고, 아직 끝나지 않은 Turn은 다음 Stop Hook 때 읽습니다.
5. Daemon은 Wire Event를 Batch로 묶어 Main Server에 보내고 Ack를 기다립니다.
6. Main Server의 Input Adapter는 Batch의 Wire Event를 Canonical Event로 바꿔 Core의 Ingest API로 넘깁니다. 저장이 끝나면 성공 Ack를 돌려줍니다.
7. Daemon은 성공 Ack를 받은 뒤에 Offset을 Batch의 끝으로 갱신합니다. 끝 위치에 닿을 때까지 4~7을 반복합니다. 끝 위치 뒤에 쓰인 내용은 다음 Stop Hook 때 읽습니다.

Hook Client는 비동기로 동작하지만 Daemon은 그럴 필요가 없습니다. Daemon은 Signal을 하나씩 순서대로 처리하고, Ack를 받기 전에는 다음 Batch를 보내지 않습니다.

## 전달 보장

Offset은 성공 Ack를 받은 뒤에만 갱신합니다. 보내다 실패한 구간은 Offset이 그대로 남으므로 같은 Session의 다음 Stop Hook 때 다시 보냅니다. Daemon이 꺼져 있는 동안 받지 못한 Signal도 같은 방식으로 다음 Stop Hook 때 함께 보내집니다.

그래서 같은 Wire Event가 두 번 이상 도착할 수 있습니다. 예를 들어 Main Server는 저장했지만 Ack가 Daemon에 닿지 못하면 같은 구간을 다시 보냅니다. Wire Event마다 다시 읽어도 바뀌지 않는 event id를 붙이고, Main Server는 이미 받은 event id를 무시합니다.

다음 경우에는 이벤트가 유실됩니다. 이 애플리케이션은 이를 허용합니다.

- 전송에 실패한 뒤 그 Session에 Stop Hook이 다시 오지 않는 경우
- Main Server가 재시도할 수 없다고 거절한 Batch
- Plugin이 해석하지 못하고 건너뛴 Session Log File의 레코드
- Session의 마지막 Turn이 끝나지 않은 채로 Session이 끝난 경우. 예를 들어 에이전트가 충돌로 종료되면 그 Turn은 끝난 것으로 판단할 수 없어 보내지 않습니다.

사용자가 중단한 Turn은 유실이 아니라 의도적으로 기록하지 않는 것입니다.

## Principles

### Observe-only

이 애플리케이션은 AI 에이전트의 작업을 관찰만 합니다. 에이전트의 동작을 차단하거나 수정하지 않으며, 에이전트의 컨텍스트에 어떠한 내용도 주입하지 않습니다. Session Log File은 읽기만 하고 수정하지 않습니다.

### Fail-open

에이전트의 작업이 이 애플리케이션 때문에 멈추어서는 안 됩니다.

- Hook Client는 에이전트로부터 input을 받으면 항상 **빈 출력과 exit code 0**으로 즉시 종료합니다.
- Daemon이 실행 중이지 않거나 Signal 전달에 실패하더라도 Hook Client는 동일하게 빈 출력과 exit code 0으로 종료합니다.
- Hook Client는 Daemon의 처리를 기다리지 않습니다. Daemon이 Ack를 기다리거나 Main Server에 연결하지 못해도 에이전트는 영향을 받지 않습니다.
- 이벤트 유실을 허용합니다.

### Masking

보안 및 개인정보 마스킹은 수행하지 않습니다. Main Server가 원격에 있으면 프롬프트와 Tool Call 결과의 원문이 네트워크로 전송됩니다.

## 결정되지 않은 사항

- 원격 Transport의 인증과 암호화 방식
- Hook Client와 Main Server의 구현 언어. Client Adapter Daemon과 Plugin은 TypeScript로 구현합니다([Implement the Client Adapter Daemon and Plugins in TypeScript](../adr/2026-10-22-implement-daemon-and-plugins-in-typescript.md)).
- 사용 범위를 팀이나 오픈소스로 넓힐 때도 Observe-only, Fail-open, Masking 원칙을 그대로 유지할지
