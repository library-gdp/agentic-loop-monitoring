# SYSTEM_ARCHITECTURE.md

이 문서는 시스템을 이루는 구성 요소와 그 사이의 데이터 흐름을 설명합니다. Main Server 내부의 모듈 구성은 [Application Architecture](APPLICATION_ARCHITECTURE.md)에서 다룹니다. 용어는 [Glossary](GLOSSARY.md)를 따릅니다.

## 구성

시스템은 에이전트가 실행되는 머신에서 동작하는 Client Adapter Daemon과, 데이터를 받아 저장하고 시각화하는 Main Server로 나뉩니다.

```
┌──────────────────────── Agent host ────────────────────────┐
│                                                            │
│  AI Agent ────── writes ──────▶ Session Log                │
│                                        ▲                   │
│                                        │ Trigger, collect  │
│                                        │                   │
│                     Client Adapter Daemon                  │
│                              └── Plugins                   │
│                                    │  ▲                    │
└────────────────────────────────────┼──┼────────────────────┘
                      Transport Unit │  │ Ack   (Transport)
                                     ▼  │
┌──────────────────────── Main Server ───────────────────────┐
│                                                            │
│  Input Adapter, Core, Persistence, Visualization           │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

| 구성 요소 | 실행 위치 | 역할 |
|---|---|---|
| Client Adapter Daemon | 에이전트 머신 | 에이전트 머신에 상주합니다. Plugin이 Session Log를 수집해 레코드 하나씩 Transport Unit으로 넘긴 Session Log Event를 Main Server에 보냅니다. |
| Main Server | 정하지 않음 | Transport Unit을 받아 Session Log Event를 저장, 조회, 시각화합니다. |

에이전트별 차이는 Client Adapter Daemon의 Plugin이 모두 흡수합니다. Session Log를 언제 수집할지(Trigger), 어떻게 수집할지도 Plugin마다 정의합니다. Main Server는 Session Log Event만 받으므로 에이전트 종류를 알 필요가 없습니다.

세부 설계는 다음 문서에서 다룹니다.

- [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md): Transport Unit 전송, Ack 처리, 설정
- [Plugin Specification](PLUGIN_SPEC.md): Plugin이 정의하는 Trigger, 수집 방식과 Transport Unit을 넘길 때 지켜야 하는 규칙
- [Agent Logging Protocol](AGENT_LOGGING_PROTOCOL.md): Transport Unit, Ack의 형식과 Transport가 지켜야 하는 규칙
- [Domain Model](DOMAIN_MODEL.md): Session Log Event와 Core가 구성하는 Session, Agent, Turn, Loop, LLM Call, Tool Call의 필드
- [Data Architecture](DATA_ARCHITECTURE.md): 데이터가 있는 곳과 소유자, Main Server가 저장하는 원본 데이터와 파생 데이터, 쓰기와 읽기

## 실행 위치와 Transport

Main Server가 어디서 실행되는지는 정하지 않습니다. Client Adapter Daemon과 같은 프로세스나 같은 머신에서 실행될 수도 있고 원격에서 실행될 수도 있습니다. 쓸 수 있는 Transport는 실행 위치에 따라 다릅니다. 같은 프로세스 안에서만 쓸 수 있는 Transport, 같은 머신의 프로세스끼리만 연결할 수 있는 Transport도 있고, 여러 머신의 Daemon이 Main Server 하나에 데이터를 보낼 수 있는 Transport도 있습니다.

## 데이터 흐름

1. 에이전트가 Session Log에 대화 내용과 LLM 호출 정보를 기록합니다.
2. Plugin은 자신이 정의한 Trigger가 발동하면, 자신이 정의한 방식으로 Session Log를 수집해 완결된 레코드를 Session Log Event로 변환합니다. Turn이 끝나기를 기다리지 않습니다.
3. Plugin은 레코드 하나에서 나온 Session Log Event를 Transport Unit 하나로 곧바로 Daemon에 넘깁니다.
4. Daemon은 Plugin이 넘긴 Transport Unit을 Main Server에 보내고 Ack를 기다립니다.
5. Main Server의 Input Adapter는 Transport Unit의 Session Log Event를 Core의 Ingest API로 넘깁니다. Core는 Turn이 끝나기를 기다리지 않고 받는 대로 저장합니다. 저장이 끝나면 성공 Ack를 돌려줍니다.

Daemon은 Transport Unit을 하나씩 보내며, Ack를 받기 전에는 다음 Transport Unit을 보내지 않습니다.

## 전달 보장

같은 Session Log Event가 두 번 이상 도착할 수 있습니다. 예를 들어 Main Server는 저장했지만 Ack가 Daemon에 닿지 못하면 Daemon이 같은 Transport Unit을 다시 보냅니다. Session Log Event마다 다시 수집해도 바뀌지 않는 event id를 붙이고, Main Server는 이미 받은 event id를 무시합니다.

다음 경우에는 이벤트가 유실됩니다. 이 애플리케이션은 이를 허용합니다.

- Main Server가 재시도할 수 없다고 거절한 Transport Unit. 그 Transport Unit이 속한 Turn은 일부만 저장됩니다.
- Plugin이 해석하지 못하고 건너뛴 Session Log의 레코드

끝나지 않은 Turn도 받은 만큼 저장합니다. 사용자가 중단한 Turn은 중단된 것으로, 에이전트가 충돌로 종료되어 끝나지 않은 Turn은 진행 중인 것으로 남습니다([Domain Model](DOMAIN_MODEL.md#turn) 참고).

## Principles

### Observe-only

이 애플리케이션은 AI 에이전트의 작업을 관찰만 합니다. 에이전트의 동작을 차단하거나 수정하지 않으며, 에이전트의 컨텍스트에 어떠한 내용도 주입하지 않습니다. Session Log는 읽기만 하고 수정하지 않습니다.

### Fail-open

에이전트의 작업이 이 애플리케이션 때문에 멈추어서는 안 됩니다.

- Plugin의 Trigger는 에이전트를 기다리게 하거나 실패하게 만들지 않습니다([Plugin Specification](PLUGIN_SPEC.md#trigger) 참고).
- Daemon이 실행 중이지 않거나, Ack를 기다리거나, Main Server에 연결하지 못해도 에이전트는 영향을 받지 않습니다.
- 이벤트 유실을 허용합니다.

### Masking

보안 및 개인정보 마스킹은 수행하지 않습니다. Main Server가 원격에 있으면 프롬프트와 Tool Call 결과의 원문이 네트워크로 전송됩니다.

## 결정되지 않은 사항

- 재시도를 모두 실패한 Transport Unit을 나중에 다시 보내는 방법
- 사용 범위를 팀이나 오픈소스로 넓힐 때도 Observe-only, Fail-open, Masking 원칙을 그대로 유지할지
