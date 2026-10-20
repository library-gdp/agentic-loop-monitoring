# PRODUCT_REQUIREMENTS.md

이 문서는 Agentic Loop Monitoring의 제품 요구사항(PRD)을 정리합니다. 무엇을, 누구를 위해, 어디까지 만드는지를 다루며, 어떻게 만드는지는 각 설계 문서에 맡깁니다. 요구사항마다 근거가 되는 설계 문서를 함께 적습니다. 용어는 [Glossary](GLOSSARY.md)를 따릅니다.

## 배경

AI 코딩 에이전트(Claude Code, Codex, OpenCode 등)는 Agentic Loop로 작업합니다. LLM을 호출하고, LLM이 요청한 도구를 실행하고, 그 결과로 다시 LLM을 호출하는 과정을 작업이 끝날 때까지 반복합니다.

이 과정은 사용자에게 잘 드러나지 않습니다. 사용자는 에이전트의 최종 응답은 보지만 다음은 알기 어렵습니다.

- 한 번의 요청을 처리하는 동안 LLM을 몇 번 호출했고 각 호출에서 무엇을 입력받아 무엇을 출력했는지
- LLM이 어떤 도구를 어떤 인자로 호출했고 결과가 무엇이었는지, 실패한 도구는 없었는지
- 토큰을 얼마나 썼고 그중 prompt cache로 처리한 양은 얼마인지
- 어느 단계에서 시간이 오래 걸렸는지

에이전트마다 이 정보를 기록하는 위치와 형식도 다릅니다. 여러 에이전트를 함께 쓰는 개발자는 이를 같은 기준으로 비교할 수 없습니다.

## 목표

1. **에이전트의 동작을 단계별로 보여줍니다.** Session, Turn, Loop, LLM Call, Tool Call의 단위로 에이전트가 무엇을 했는지 확인할 수 있게 합니다.
2. **자원 사용량을 측정합니다.** LLM Call마다 Token Usage와 Duration을 기록하고, Loop, Turn, Session 단위로 모아 볼 수 있게 합니다.
3. **에이전트 종류와 무관하게 같은 모델로 봅니다.** 에이전트별 기록 형식의 차이를 수집 단계에서 흡수해, 저장과 시각화는 하나의 공통 모델로 다룹니다.
4. **에이전트의 작업을 방해하지 않습니다.** 모니터링 때문에 에이전트가 멈추거나, 느려지거나, 동작이 바뀌는 일이 없어야 합니다.
5. **로컬과 원격 배포를 모두 지원합니다.** Main Server를 에이전트와 같은 머신에서 띄울 수도 있고, 여러 머신의 데이터를 원격 Main Server 하나로 모을 수도 있습니다.

## 비목표

다음은 이 제품이 하지 않는 일입니다.

| 비목표 | 이유 | 근거 |
|---|---|---|
| 에이전트의 동작을 차단, 수정하거나 컨텍스트에 내용을 주입 | Observe-only 원칙 | [System Architecture](SYSTEM_ARCHITECTURE.md#observe-only) |
| 진행 중인 Turn의 실시간 표시 | 수집은 Stop Hook에서만 시작하므로 데이터는 Turn이 끝난 뒤에 들어옵니다. | [ADR: 증분 읽기](../adr/2026-10-19-read-session-log-files-incrementally-from-acked-offset.md) |
| 모든 이벤트의 전달 보장 | Fail-open 원칙에 따라 일부 유실을 허용합니다. [허용하는 유실](#허용하는-유실)을 참고하세요. | [System Architecture](SYSTEM_ARCHITECTURE.md#전달-보장) |
| 사용자가 중단한 Turn의 기록 | 의도적으로 기록하지 않습니다. | [Plugin Specification](PLUGIN_SPEC.md#turn-단위) |
| 프롬프트와 Tool Call 결과의 보안, 개인정보 마스킹 | 원문을 그대로 수집합니다. | [System Architecture](SYSTEM_ARCHITECTURE.md#masking) |
| 덧붙여 쓰는 단일 파일이 아닌 Session Log File의 처리 | 바이트 Offset은 덧붙여 쓰는 파일을 전제로 합니다. | [Plugin Specification](PLUGIN_SPEC.md#결정되지-않은-사항) |

## 사용자

| 사용자 | 하려는 일 |
|---|---|
| AI 코딩 에이전트를 쓰는 개발자 | 자기 머신에서 에이전트가 한 작업을 돌아보고, 토큰과 시간을 어디에 썼는지 확인합니다. Main Server를 같은 머신에서 띄웁니다. |
| 여러 머신이나 여러 에이전트를 함께 쓰는 개발자 | 여러 머신의 에이전트 작업을 원격 Main Server 하나에 모아, 에이전트와 머신을 가리지 않고 같은 기준으로 비교합니다. |
| 새 에이전트 지원을 추가하는 기여자 | Main Server를 바꾸지 않고 Plugin 하나만 추가해 새 에이전트의 데이터를 수집합니다. |

## 사용 시나리오

### 한 Turn을 돌아보기

1. 개발자가 Claude Code에 프롬프트를 입력하고, 에이전트가 작업을 마칩니다.
2. 개발자는 Visualization에서 그 Session을 열고 방금 끝난 Turn을 고릅니다.
3. Turn 안의 Loop를 순서대로 봅니다. Loop마다 LLM Call의 입력, 출력, reasoning과 그 LLM Call이 요청한 Tool Call의 인자, 결과, 성공 여부를 확인합니다.
4. Loop마다 Token Usage와 Duration을 비교해, 토큰이나 시간을 많이 쓴 Loop를 찾습니다.

### 여러 머신의 데이터를 모으기

1. 개발자가 원격 Main Server를 띄웁니다.
2. 각 머신에 Client Adapter Daemon을 설치하고 Transport를 REST API, Streamable HTTP, WebSocket 중 하나로 설정합니다.
3. 각 에이전트의 Stop Hook에 Hook Client를 등록합니다.
4. 이후 각 머신에서 끝난 Turn이 원격 Main Server에 모이고, 개발자는 한 곳에서 조회합니다.

### Main Server가 잠시 꺼져 있었을 때

1. Main Server가 꺼져 있는 동안 개발자가 에이전트로 작업합니다. 에이전트는 아무 영향 없이 동작합니다.
2. Main Server를 다시 띄운 뒤 같은 Session에서 Turn이 하나 더 끝나면, 꺼져 있던 동안의 Turn까지 함께 저장됩니다.

## 기능 요구사항

### 수집

| ID | 요구사항 | 근거 |
|---|---|---|
| C-1 | 각 에이전트의 Stop Hook에만 Hook Client를 등록합니다. 다른 Hook은 쓰지 않습니다. | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#hook-등록) |
| C-2 | Hook Client는 Hook payload 원문과 에이전트 id를 담은 Signal을 Daemon에 보내고, 처리 결과를 기다리지 않고 빈 출력과 exit code 0으로 즉시 종료합니다. | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#hook-client-동작) |
| C-3 | Daemon이 실행 중이지 않거나 Signal 전달에 실패해도 Hook Client는 C-2와 같이 종료합니다. | [System Architecture](SYSTEM_ARCHITECTURE.md#fail-open) |
| C-4 | Daemon은 에이전트를 실행하는 사용자 계정마다 하나씩 상주하며, 그 사용자의 권한으로 실행합니다. | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#실행) |
| C-5 | Daemon은 Signal을 받았을 때만 Session Log File을 읽습니다. 시작할 때 미리 훑거나 파일 변경을 감시하지 않습니다. | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#실행) |
| C-6 | Daemon은 Session별 Offset부터 읽어, Stop Hook 한 번에 읽는 양이 Session 전체가 아니라 직전에 보내지 않은 구간에 비례하게 합니다. | [ADR: 증분 읽기](../adr/2026-10-19-read-session-log-files-incrementally-from-acked-offset.md) |
| C-7 | Daemon은 Signal 처리를 시작할 때의 파일 크기를 끝 위치로 두고, 그 뒤에 쓰인 내용은 다음 Stop Hook 때 읽습니다. | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#처리-순서) |
| C-8 | 같은 Session의 Signal이 이미 큐에서 기다리고 있으면 새 Signal은 버립니다. | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#큐에-넣기) |
| C-9 | Session Log File이 교체되거나, 잘리거나, 경로가 바뀌면 처음부터 다시 읽습니다. Offset 레코드가 손상되면 그 Session만 처음부터 다시 읽습니다. | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#offset-검증) |

### 에이전트 지원(Plugin)

| ID | 요구사항 | 근거 |
|---|---|---|
| P-1 | Claude Code(`claude-code`), Codex(`codex`), OpenCode(`opencode`)를 지원합니다. 에이전트마다 Plugin을 하나씩 둡니다. | [Plugin Specification](PLUGIN_SPEC.md#에이전트-id) |
| P-2 | Plugin은 Hook payload에서 Session Log File을 찾고, 주어진 Offset부터 읽어 Wire Event로 변환합니다. | [Plugin Specification](PLUGIN_SPEC.md#인터페이스) |
| P-3 | Plugin은 끝난 Turn까지만 Wire Event로 보냅니다. 끝나지 않은 Turn은 다음 읽기에서 처음부터 다시 읽습니다. | [Plugin Specification](PLUGIN_SPEC.md#read) |
| P-4 | 사용자가 중단한 Turn은 Wire Event를 만들지 않고 건너뜁니다. 에이전트가 중단을 기록하지 않으면 다음 Turn이 시작될 때 오류로 끝난 Turn으로 보냅니다. | [Plugin Specification](PLUGIN_SPEC.md#turn-단위) |
| P-5 | 에이전트가 기록하지 않은 값은 만들어 넣지 않습니다. 예를 들어 Cache Write Token이 없으면 `0`이 아니라 빈 값으로 둡니다. | [Plugin Specification](PLUGIN_SPEC.md#read) |
| P-6 | 해석할 수 없는 레코드는 로그를 남기고 건너뜁니다. 레코드 하나 때문에 그 뒤의 구간을 보내지 못하는 일은 없어야 합니다. | [Plugin Specification](PLUGIN_SPEC.md#read) |
| P-7 | Plugin은 결정적입니다. 같은 레코드를 다시 읽으면 같은 event id가 나옵니다. | [Plugin Specification](PLUGIN_SPEC.md#event-id) |
| P-8 | 새 에이전트를 지원할 때 Plugin만 추가하며, Main Server의 코드는 바꾸지 않습니다. | [ADR: Daemon/Main Server 분리](../adr/2026-10-19-split-system-into-client-adapter-daemon-and-main-server.md) |

### 전송

| ID | 요구사항 | 근거 |
|---|---|---|
| T-1 | Daemon은 Wire Event를 Batch로 묶어 Main Server에 보냅니다. Batch는 끝난 Turn만 담으며, Turn 하나가 여러 Batch에 나뉘지 않습니다. | [Wire Protocol](WIRE_PROTOCOL.md#turn의-경계) |
| T-2 | Transport로 표준입출력, Unix Socket, REST API, Streamable HTTP, WebSocket을 지원합니다. 표준입출력과 Unix Socket은 같은 머신에서만 씁니다. | [Wire Protocol](WIRE_PROTOCOL.md#transport-바인딩) |
| T-3 | Daemon은 성공 Ack를 받은 뒤에만 Offset을 갱신합니다. 일시적인 전송 실패나 Daemon 중단으로 보내지 못한 구간은 같은 Session의 다음 Stop Hook 때 다시 보냅니다. | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#ack-처리) |
| T-4 | 재시도 가능한 실패는 정해진 횟수만큼 간격을 늘려가며 재시도합니다. 재시도할 수 없는 거절은 Batch를 버리고 Offset을 넘깁니다. | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#ack-처리) |
| T-5 | Batch에 에이전트 id, Plugin 버전, 머신 이름, session id, 작업 디렉터리를 싣습니다. | [Wire Protocol](WIRE_PROTOCOL.md#batch) |
| T-6 | Wire Protocol은 버전을 가지며, Main Server는 지원하는 버전마다 Decoder를 둡니다. 같은 버전 안에서는 Wire Event 종류와 선택 필드를 추가할 수 있습니다. | [Wire Protocol](WIRE_PROTOCOL.md#버전) |

### 저장

| ID | 요구사항 | 근거 |
|---|---|---|
| S-1 | Main Server는 Wire Event를 Canonical Event로 바꿔 저장합니다. 에이전트 종류에 따라 분기하지 않습니다. | [Application Architecture](APPLICATION_ARCHITECTURE.md#input-adapter) |
| S-2 | 저장은 멱등입니다. `(에이전트 id, session id, event id)`가 이미 저장되어 있으면 무시하고 성공으로 응답합니다. | [Wire Protocol](WIRE_PROTOCOL.md#규칙) |
| S-3 | Batch의 Wire Event를 모두 저장한 뒤에만 성공 Ack를 보냅니다. | [Wire Protocol](WIRE_PROTOCOL.md#규칙) |
| S-4 | Wire Event 하나가 잘못되었으면 그 Wire Event만 버리고 나머지를 저장합니다. | [Wire Protocol](WIRE_PROTOCOL.md#규칙) |
| S-5 | Core는 같은 Session의 Wire Event 순서와 연결 관계로 Turn, Loop, LLM Call, Tool Call을 구성합니다. Turn이 최종 응답으로 끝났는지, 오류나 충돌로 끝났는지 구분합니다. | [Wire Protocol](WIRE_PROTOCOL.md#turn의-경계) |
| S-6 | LLM Call에 `started_at`이 없으면 앞선 Wire Event의 시각으로 Duration을 추정합니다. | [Wire Protocol](WIRE_PROTOCOL.md#assistant_message) |

### 조회와 시각화

Visualization은 Core의 Query API로만 데이터를 조회합니다([Application Architecture](APPLICATION_ARCHITECTURE.md#visualization)). 화면 구성과 Query API는 아직 정의되지 않았으며, 아래는 [README](../README.md)의 기능과 [Glossary](GLOSSARY.md)의 도메인 모델에서 끌어낸 요구사항입니다.

| ID | 요구사항 |
|---|---|
| V-1 | Session 목록을 보여줍니다. 에이전트, 머신, 작업 디렉터리, 시간으로 Session을 찾을 수 있습니다. |
| V-2 | Session에서 Turn, Turn에서 Loop, Loop에서 LLM Call과 Tool Call로 내려가며 볼 수 있습니다. |
| V-3 | LLM Call의 입력, 출력, reasoning, 모델 이름, Token Usage, Duration을 보여줍니다. |
| V-4 | Tool Call의 도구 이름, 인자, 결과, 성공 여부, Duration을 보여주고, 자신을 요청한 LLM Call과 연결해 보여줍니다. |
| V-5 | Token Usage를 Input Token, Output Token, Cache Read Token, Cache Write Token, Reasoning Token으로 나누어 보여줍니다. 에이전트가 기록하지 않은 항목은 `0`이 아니라 값이 없음으로 표시합니다. |
| V-6 | Loop 단위로 Token Usage와 Duration을 비교할 수 있습니다. Turn과 Session 단위의 합계도 보여줍니다. |
| V-7 | 오류나 충돌로 끝난 Turn과 실패한 Tool Call을 구분해 보여줍니다. |
| V-8 | Subagent를 자신을 띄운 Tool Call 아래에 이어서 보여줍니다. Subagent를 잇는 방식은 아직 정해지지 않았습니다([결정되지 않은 사항](#결정되지-않은-사항) 참고). |

## 데이터 요구사항

수집하고 저장하는 도메인 모델은 다음과 같습니다. 정의는 [Glossary](GLOSSARY.md)를 따릅니다.

```
Session
└── Turn
    └── Loop
        ├── LLM Call
        └── Tool Call ── (Subagent)
```

| 단위 | 기록하는 값 |
|---|---|
| Session | session id, 에이전트, 머신, 작업 디렉터리, Duration |
| Turn | 사용자 프롬프트, 끝난 방식(최종 응답, 오류나 충돌), Duration |
| Loop | LLM Call 한 번과 그 응답이 요청한 Tool Call들, Duration |
| LLM Call | input, output, reasoning, Token Usage, 모델 이름, Duration |
| Tool Call | 도구 이름, 인자, 결과, 성공 여부, Duration, 요청한 LLM Call |

에이전트가 기록하지 않은 값은 비워 둡니다. 저장과 시각화는 값이 없는 경우를 `0`과 구분해야 합니다.

## 비기능 요구사항

| 분류 | 요구사항 | 근거 |
|---|---|---|
| Observe-only | 에이전트의 동작을 차단하거나 수정하지 않고, 컨텍스트에 아무것도 주입하지 않습니다. Session Log File은 읽기만 합니다. | [System Architecture](SYSTEM_ARCHITECTURE.md#observe-only) |
| Fail-open | Daemon이나 Main Server의 상태와 무관하게 에이전트는 영향을 받지 않습니다. Hook Client는 항상 빈 출력과 exit code 0으로 즉시 종료합니다. | [System Architecture](SYSTEM_ARCHITECTURE.md#fail-open) |
| 신뢰성 | 일시적인 전송 실패, Main Server 중단, Daemon 중단으로는 데이터를 잃지 않습니다. 같은 Session에 다음 Stop Hook이 오면 빠진 구간을 보냅니다. | [System Architecture](SYSTEM_ARCHITECTURE.md#전달-보장) |
| 정확성 | 같은 Wire Event가 여러 번 도착해도 한 번만 저장됩니다. | [Wire Protocol](WIRE_PROTOCOL.md#규칙) |
| 내구성 | Offset 갱신 도중 Daemon이 강제 종료되어도 Offset 레코드는 이전 값이나 새 값 중 하나로 남습니다. Session 하나의 레코드가 손상되어도 다른 Session에 영향이 없습니다. | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#갱신) |
| 성능 | Stop Hook 한 번의 처리량은 Session 크기가 아니라 직전에 보내지 않은 구간에 비례합니다. 에이전트가 파일에 계속 써도 Signal 하나의 처리는 끝 위치에서 끝납니다. | [ADR: 증분 읽기](../adr/2026-10-19-read-session-log-files-incrementally-from-acked-offset.md) |
| 확장성 | 새 에이전트는 Plugin 추가만으로 지원합니다. Main Server는 Persistence와 Transport를 모듈 단위로 교체할 수 있습니다. | [Application Architecture](APPLICATION_ARCHITECTURE.md#philosophy) |
| 호환성 | Wire Protocol은 호환되지 않는 변경에만 버전을 올립니다. 머신마다 Plugin 버전이 달라도 Main Server가 받을 수 있어야 합니다. | [Wire Protocol](WIRE_PROTOCOL.md#버전) |
| 보안 | Signal Socket은 소유자만 읽고 쓸 수 있게 합니다(`0600`). 마스킹은 하지 않으므로, Main Server가 원격에 있으면 프롬프트와 Tool Call 결과의 원문이 네트워크로 나갑니다. | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#signal-socket) |
| 관측 가능성 | Daemon은 Signal을 버린 경우, 레코드를 건너뛴 경우, 중단된 Turn을 버린 경우, 전송에 실패한 경우를 자신의 로그 파일에 남깁니다. 에이전트에는 아무것도 출력하지 않습니다. | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#로그) |

## 허용하는 유실

다음 경우에는 데이터가 저장되지 않으며, 제품은 이를 허용합니다([System Architecture](SYSTEM_ARCHITECTURE.md#전달-보장)).

- 전송에 실패한 뒤 그 Session에 Stop Hook이 다시 오지 않는 경우
- Main Server가 재시도할 수 없다고 거절한 Batch
- Plugin이 해석하지 못하고 건너뛴 레코드
- 에이전트가 충돌로 종료되어 Session의 마지막 Turn이 끝나지 않은 경우

사용자가 중단한 Turn은 유실이 아니라 의도적으로 기록하지 않는 것입니다.

## 인수 기준

다음을 만족하면 요구사항을 충족한 것으로 봅니다. ADR의 Verification 항목을 제품 관점에서 다시 정리한 것입니다.

**에이전트 영향**

- [ ] Daemon이 꺼져 있거나 Main Server에 연결할 수 없어도, Hook Client는 빈 출력과 exit code 0으로 즉시 종료하고 에이전트는 평소처럼 동작합니다.

**수집과 전달**

- [ ] Claude Code, Codex, OpenCode에서 끝난 Turn이 Main Server에 저장됩니다.
- [ ] 같은 Session에 Stop Hook이 두 번 오면, 두 번째에는 첫 번째 성공 Ack 이후에 덧붙은 부분만 읽습니다.
- [ ] Main Server를 멈춘 상태에서 Turn을 마친 뒤 Main Server를 다시 띄우고 같은 Session에서 Turn을 하나 더 마치면, 두 Turn이 모두 저장됩니다.
- [ ] 같은 Batch를 두 번 보내도 저장된 결과가 한 번 보낸 것과 같습니다.
- [ ] 사용자가 중단한 Turn은 저장되지 않고, 그 뒤의 Turn은 저장됩니다.
- [ ] 진행 중인 Turn은 저장되지 않고, 그 Turn이 끝난 뒤의 Stop Hook에서 Turn 전체가 저장됩니다.

**구조**

- [ ] Main Server가 Daemon과 다른 머신에서 REST API, Streamable HTTP, WebSocket 중 하나로 Batch를 받아 저장합니다.
- [ ] Main Server의 코드에 에이전트별 Session Log File 형식을 해석하는 부분이 없습니다.
- [ ] 새 에이전트용 Plugin을 추가할 때 Main Server의 코드를 바꾸지 않아도 그 에이전트의 데이터가 저장됩니다.

**시각화**

- [ ] 저장된 Turn을 Loop 단위로 펼쳐, Loop마다 LLM Call과 Tool Call의 내용, Token Usage, Duration을 볼 수 있습니다.

## 결정되지 않은 사항

설계 문서에 흩어진 미결 사항을 모았습니다. 각 항목은 해당 문서나 후속 ADR에서 정합니다.

| 항목 | 관련 문서 |
|---|---|
| 구현 언어와 코드 디렉터리 구성 | [ADR: Daemon/Main Server 분리](../adr/2026-10-19-split-system-into-client-adapter-daemon-and-main-server.md) |
| Main Server의 배포 위치 | [ADR: Daemon/Main Server 분리](../adr/2026-10-19-split-system-into-client-adapter-daemon-and-main-server.md) |
| 원격 Transport의 인증과 암호화 | [System Architecture](SYSTEM_ARCHITECTURE.md#결정되지-않은-사항), [Wire Protocol](WIRE_PROTOCOL.md#결정되지-않은-사항) |
| Daemon을 시작하고 상주시키는 방식(systemd user service, launchd 등) | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#결정되지-않은-사항) |
| Hook Client를 에이전트에 등록하고 해제하는 설치 방식 | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#결정되지-않은-사항) |
| 상태 디렉터리의 기본 위치 | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#결정되지-않은-사항) |
| Hook Client 타임아웃, Ack 타임아웃, 재시도 횟수, Batch 크기 한도의 기본값 | [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#결정되지-않은-사항) |
| Plugin을 Daemon에 넣는 방식(빌드할 때 포함 또는 실행 중 로딩) | [Plugin Specification](PLUGIN_SPEC.md#결정되지-않은-사항) |
| 덧붙여 쓰지 않는 Session Log File을 쓰는 에이전트의 처리 | [Plugin Specification](PLUGIN_SPEC.md#결정되지-않은-사항) |
| Subagent의 Session Log File과 부모 Session, 부모 Tool Call의 연결 | [Plugin Specification](PLUGIN_SPEC.md#결정되지-않은-사항), [Wire Protocol](WIRE_PROTOCOL.md#결정되지-않은-사항) |
| Main Server가 받는 Batch 크기의 상한과 초과 시 응답 | [Wire Protocol](WIRE_PROTOCOL.md#결정되지-않은-사항) |
| 에이전트의 원본 레코드를 Wire Event에 함께 실을지 여부 | [Wire Protocol](WIRE_PROTOCOL.md#결정되지-않은-사항) |
| Canonical Event 모델과 Ingest API, Query API, Repository API 명세 | [Application Architecture](APPLICATION_ARCHITECTURE.md#core) |
| Persistence의 저장소 종류 | [Application Architecture](APPLICATION_ARCHITECTURE.md#persistence) |
| Visualization의 형태(웹 UI, CLI 등)와 화면 구성 | [Application Architecture](APPLICATION_ARCHITECTURE.md#visualization) |
| 데이터 보존 기간과 삭제 방식 | 없음 |
| 제품의 성공을 판단할 정량 지표 | 없음 |
