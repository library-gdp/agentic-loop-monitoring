# CLIENT_ADAPTER_DAEMON.md

이 문서는 Client Adapter Daemon(이하 Daemon)과 Hook Client의 동작을 설명합니다. 시스템 안에서 Daemon이 차지하는 위치는 [System Architecture](SYSTEM_ARCHITECTURE.md)를, 용어는 [Glossary](GLOSSARY.md)를 참고하세요.

## 구성 요소

| 구성 요소 | 역할 |
|---|---|
| Signal Receiver | Signal Socket에서 Hook Client가 보낸 Signal을 받아 Signal Queue에 넣습니다. |
| Signal Queue | 처리를 기다리는 Signal의 큐입니다. |
| Worker | Signal Queue에서 Signal을 하나씩 꺼내 Session Log File을 읽고 Main Server로 보냅니다. |
| Plugin | 에이전트별로 Session Log File을 찾고, 읽고, Wire Event로 변환합니다. [Plugin Specification](PLUGIN_SPEC.md)을 따릅니다. |
| Offset Store | Session별 Offset을 기록하는 곳입니다. Session마다 Offset 레코드 파일 하나를 둡니다. |
| Transport Client | 설정된 Transport로 Main Server에 Batch를 보내고 Ack를 받습니다. [Wire Protocol](WIRE_PROTOCOL.md)을 따릅니다. |

## 실행

Daemon은 에이전트를 실행하는 사용자 계정마다 하나씩 상주합니다. Session Log File은 보통 사용자의 홈 디렉터리 아래에 있으므로, Daemon은 그 사용자의 권한으로 실행합니다. Daemon과 Plugin은 TypeScript로 구현합니다([Implement the Client Adapter Daemon and Plugins in TypeScript](../adr/2026-10-22-implement-daemon-and-plugins-in-typescript.md)).

- Daemon은 시작할 때 Signal Socket을 만듭니다. 이미 다른 Daemon이 그 Signal Socket에서 Signal을 받고 있으면 시작하지 않고 종료합니다.
- Daemon은 시작할 때 Session Log File을 미리 훑지 않습니다. 읽기는 항상 Signal을 받았을 때만 시작합니다.
- Daemon이 Batch를 보내는 중에 종료되면 그 Batch의 Offset은 갱신되지 않습니다. 다음에 같은 구간을 다시 보내며, 중복은 Main Server가 걸러냅니다.

## Hook Client와 Signal

### Hook 등록

각 에이전트의 Stop Hook에만 Hook Client를 등록합니다. 다른 Hook은 쓰지 않습니다. Hook Client는 인자로 에이전트 id를 받습니다. 에이전트 id는 [Plugin Specification](PLUGIN_SPEC.md#에이전트-id)에서 정합니다.

```
<hook-client> claude-code
```

### Hook Client 동작

Hook Client는 Daemon에 신호만 보냅니다. Session Log File을 읽거나 Hook payload를 해석하지 않습니다.

1. 표준입력으로 받은 Hook payload를 끝까지 읽습니다.
2. 에이전트 id와 Hook payload 원문으로 Signal을 만듭니다.
3. Signal Socket에 연결해 Signal을 쓰고 연결을 닫습니다. Daemon의 응답은 기다리지 않습니다.
4. 빈 출력과 exit code 0으로 종료합니다.

연결과 쓰기에는 짧은 타임아웃을 둡니다. Signal Socket이 없거나, 연결이나 쓰기에 실패하거나, 타임아웃이 나도 4번과 같이 종료합니다. 이 경우 Signal은 버려지지만 Offset은 그대로 남으므로, 그 구간은 같은 Session의 다음 Stop Hook 때 함께 보냅니다.

### Signal Socket

Hook Client와 Daemon은 항상 같은 머신에서 실행되므로 Signal은 Unix Socket으로 주고받습니다. Signal Socket은 Daemon의 상태 디렉터리 아래에 두고, 소유자만 읽고 쓸 수 있게 합니다(권한 `0600`). Signal Socket은 Main Server와 통신하는 Transport와 별개입니다.

### Signal 형식

Signal은 UTF-8 JSON 객체 하나이며, 연결 하나에 Signal 하나를 보냅니다.

```json
{
  "signal_version": 1,
  "agent": "claude-code",
  "received_at": "2026-10-19T14:22:34.120Z",
  "hook_payload": "{\"session_id\":\"...\",\"transcript_path\":\"...\"}"
}
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `signal_version` | integer | Signal 형식의 버전입니다. 지금은 `1`입니다. |
| `agent` | string | Hook Client가 인자로 받은 에이전트 id입니다. |
| `received_at` | string | Hook Client가 실행된 시각입니다. RFC 3339 형식이며 시간대를 포함합니다. |
| `hook_payload` | string | Hook Client가 표준입력으로 받은 Hook payload 원문입니다. Hook Client는 이 값을 해석하지 않습니다. |

## Signal 처리

### 큐에 넣기

Signal Receiver는 Signal을 받으면 다음을 수행합니다.

1. `agent`에 맞는 Plugin을 찾습니다. 없으면 로그를 남기고 Signal을 버립니다.
2. Plugin의 `resolve`로 Hook payload에서 Session Log File을 알아냅니다. 실패하면 로그를 남기고 Signal을 버립니다.
3. 같은 Session(에이전트 id와 session id가 같음)의 Signal이 이미 Signal Queue에서 기다리고 있으면 새 Signal은 버립니다. 기다리던 Signal을 처리할 때 그 시점의 끝 위치까지 읽기 때문입니다.
4. 그렇지 않으면 Signal Queue 끝에 넣습니다.

### 처리 순서

Worker는 하나이며, Signal을 받은 순서대로 하나씩 처리합니다. 한 Signal의 처리가 끝나야 다음 Signal을 꺼냅니다. Batch를 보낸 뒤에는 Ack를 받거나 타임아웃이 날 때까지 기다리며, 그동안 다른 Batch를 보내지 않습니다.

Signal 하나는 다음 순서로 처리합니다.

1. Offset Store에서 Session의 Offset 레코드를 꺼내 [검증](#offset-검증)합니다. 이 결과로 읽기 시작할 Offset과 Plugin State가 정해집니다.
2. Plugin의 `mark_end`로 끝 위치를 받습니다. 이 Signal의 처리는 끝 위치까지만 읽습니다. 끝 위치를 어떻게 정하는지는 Plugin이 맡습니다([Plugin Specification](PLUGIN_SPEC.md#mark_end) 참고).
3. Plugin의 `read`로 Offset부터 읽어 Wire Event와 다음 Offset, 다음 Plugin State를 받습니다. 한 번에 읽는 양은 Batch 크기 한도를 넘지 않으며, 2번에서 받은 끝 위치를 `end`로 넘깁니다.
4. 다음 Offset이 지금 Offset과 같으면 끝 위치까지 더 읽을 것이 없으므로 처리를 끝냅니다.
5. Wire Event가 없으면(사용자가 중단한 Turn이나 건너뛴 레코드만 있었던 경우) Main Server에 보내지 않고 6번의 Offset 갱신만 합니다.
6. Wire Event를 Batch로 묶어 Main Server에 보내고 Ack를 기다립니다. 결과에 따라 [Ack 처리](#ack-처리)를 따릅니다.
7. 처리를 끝내지 않았다면 3번으로 돌아갑니다.

끝 위치를 두는 이유는 에이전트가 파일에 계속 쓰는 동안 Worker가 파일 끝을 따라가며 처리를 끝내지 못하는 일을 막기 위해서입니다. Worker는 하나이므로 그동안 다른 Session의 Signal이 모두 기다리게 됩니다. 끝 위치 뒤에 쓰인 내용은 같은 Session의 다음 Stop Hook 때 읽습니다.

끝 위치는 Turn의 경계와 일치하지 않을 수 있습니다. Hook Client가 비동기로 실행되고 Signal이 큐에서 기다리기도 하므로, Signal 처리를 시작할 때 다음 Turn의 앞부분이 이미 기록되어 있을 수 있습니다. Plugin은 끝난 Turn까지만 소비하므로 이 부분은 보내지 않고, 그 Turn이 끝난 뒤의 Stop Hook 때 처음부터 읽어 보냅니다([Plugin Specification](PLUGIN_SPEC.md#turn-단위) 참고).

### Ack 처리

| 결과 | Offset | 다음 동작 |
|---|---|---|
| 성공 Ack | Batch 끝으로 갱신 | 3번으로 돌아가 다음 구간을 읽습니다. |
| 재시도 가능한 실패: 연결 실패, 전송 실패, Ack 타임아웃, `retryable`이 `true`인 거절 Ack | 갱신하지 않음 | 정해진 횟수만큼 간격을 늘려가며 같은 Batch를 다시 보냅니다. 모두 실패하면 로그를 남기고 이 Signal의 처리를 끝냅니다. 남은 구간은 같은 Session의 다음 Stop Hook 때 보냅니다. |
| 재시도할 수 없는 실패: `retryable`이 `false`인 거절 Ack | Batch 끝으로 갱신 | 로그를 남기고 Batch를 버립니다. 3번으로 돌아가 다음 구간을 읽습니다. |

재시도할 수 없는 실패에서도 Offset을 갱신하는 이유는, 같은 Batch를 다시 보내도 또 거절되어 그 뒤의 구간까지 영영 보내지 못하게 되기 때문입니다.

## Offset 관리

### Offset

Offset은 Session Log File의 처음부터 센 바이트 수입니다. 0이면 파일 처음부터 읽습니다. 다음 Offset은 Plugin이 정하며, 항상 Plugin이 소비한 마지막 Turn의 바로 다음 위치입니다. 아직 끝나지 않은 Turn은 소비하지 않으므로 다음 읽기에서 그 Turn의 처음부터 다시 읽습니다. 자세한 규칙은 [Plugin Specification](PLUGIN_SPEC.md#read)을 참고하세요.

### Offset Store

Offset은 Session별로 저장합니다. Offset Store는 Daemon의 상태 디렉터리 아래 `offsets/` 디렉터리이며, Session마다 Offset 레코드 파일 하나를 둡니다.

```
<상태 디렉터리>/offsets/<agent>/<session_id>.json
```

`<agent>`는 에이전트 id이고 `<session_id>`는 Plugin의 `resolve`가 알려준 session id입니다. 서로 다른 에이전트의 session id가 겹쳐도 디렉터리가 나뉘므로 충돌하지 않습니다. session id에 파일 이름으로 쓸 수 없는 문자(`/`, NUL)나 `%`가 있으면 그 바이트를 퍼센트 인코딩(예: `/` → `%2F`)해서 파일 이름을 만듭니다.

Offset 레코드 파일의 내용은 다음과 같습니다.

```json
{
  "record_version": 1,
  "agent": "claude-code",
  "session_id": "9b2e...",
  "offset": 48213,
  "plugin_state": null,
  "updated_at": "2026-10-19T14:22:35.402Z"
}
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `record_version` | integer | Offset 레코드 형식의 버전입니다. 지금은 `1`입니다. |
| `agent` | string | Session의 에이전트 id입니다. |
| `session_id` | string | 에이전트가 부여한 session id입니다. 인코딩하지 않은 원래 값입니다. |
| `offset` | integer | Offset입니다. |
| `plugin_state` | any | Plugin이 다음 `read`에 넘겨달라고 돌려준 값입니다. Daemon은 내용을 해석하지 않고 그대로 저장합니다. |
| `updated_at` | string | 레코드를 마지막으로 갱신한 시각입니다. RFC 3339 형식입니다. |

Daemon은 Session Log File의 경로나 파일 정보를 기록하지 않습니다. Session의 기록이 어느 파일에 어떻게 나뉘는지, 파일이 바뀌었는지는 에이전트마다 다르므로 Plugin이 판단합니다([Plugin Specification](PLUGIN_SPEC.md#plugin-state) 참고).

### 갱신

- Offset과 Plugin State는 함께 갱신합니다. 둘 중 하나만 갱신된 상태가 남으면 안 됩니다.
- 갱신은 원자적으로 합니다. 같은 디렉터리의 임시 파일에 레코드 전체를 쓰고 `fsync`한 뒤 Offset 레코드 파일 이름으로 rename합니다.
- 갱신할 때는 그 Session의 Offset 레코드 파일만 다시 씁니다. 다른 Session의 레코드는 건드리지 않습니다.
- Offset Store를 쓰는 것은 Worker 하나뿐이므로 파일 잠금은 두지 않습니다.

### Offset 검증

Worker는 Session Log File을 읽기 전에 Session의 Offset 레코드를 꺼내 읽기 시작할 위치를 정합니다.

| 상황 | 판단 기준 | 처리 |
|---|---|---|
| 처음 보는 Session | Offset 레코드 파일이 없음 | Offset 0, Plugin State 없음으로 시작합니다. |
| 그 외 | | 레코드의 Offset과 Plugin State로 이어서 읽습니다. |

Session Log File이 바뀌었거나 없어진 경우의 처리는 Plugin의 `read`가 맡습니다. 처음부터 다시 읽으면 이미 보낸 Wire Event가 다시 갈 수 있습니다. 파일 내용이 같다면 event id도 같으므로 Main Server가 걸러냅니다.

Offset 레코드 파일을 해석할 수 없으면 로그를 남기고 그 파일을 다른 이름으로 옮긴 뒤, 그 Session만 Offset 0, Plugin State 없음으로 시작합니다. 다른 Session의 Offset에는 영향이 없으며, 중복은 Main Server가 걸러냅니다.

## 설정

| 항목 | 설명 |
|---|---|
| 상태 디렉터리 | Signal Socket, Offset Store, Daemon 로그를 두는 디렉터리입니다. |
| Transport | 사용할 Transport의 종류와 주소입니다. 표준입출력이면 실행할 Main Server 명령입니다. |
| Ack 타임아웃 | Batch를 보낸 뒤 Ack를 기다리는 최대 시간입니다. |
| 재시도 횟수와 간격 | 재시도 가능한 실패에서 같은 Batch를 다시 보내는 횟수와 간격입니다. |
| Batch 크기 한도 | Batch 하나에 담는 Wire Event 수와 바이트 수의 최댓값입니다. Turn 하나가 한도보다 크면 그 Turn만 담아 보냅니다. |
| 사용할 Plugin | 실행 파일에 들어 있는 Plugin 가운데 활성화할 에이전트 id 목록입니다. |

## 로그

Daemon은 자신의 로그 파일에만 기록하며, 에이전트에는 아무것도 출력하지 않습니다. 다음 경우에는 로그를 남깁니다.

- Signal을 버린 경우와 그 이유
- Plugin이 레코드를 해석하지 못하고 건너뛴 경우
- 사용자가 중단한 Turn을 버린 경우
- 재시도 가능한 실패와 재시도를 모두 실패한 경우
- 재시도할 수 없는 거절로 Batch를 버린 경우
- Offset 레코드 파일을 해석하지 못해 Session을 처음부터 다시 읽은 경우

## 결정되지 않은 사항

- TypeScript를 실행할 런타임과 Daemon을 실행 파일 하나로 빌드하는 방법
- Hook Client의 구현 언어
- Daemon을 시작하고 상주시키는 방식(예: systemd user service, launchd)
- 각 에이전트에 Hook Client를 등록하고 해제하는 설치 방식
- 상태 디렉터리의 기본 위치
- 더 이상 쓰지 않는 Session의 Offset 레코드 파일을 지우는 방법
- Hook Client의 타임아웃, Ack 타임아웃, 재시도 횟수, Batch 크기 한도의 기본값
