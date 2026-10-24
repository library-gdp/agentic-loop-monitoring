# AGENT_LOGGING_PROTOCOL.md

이 문서는 Client Adapter Daemon과 Main Server가 주고받는 메시지의 형식과, Transport별로 메시지를 실어 나르는 방식을 정의합니다. 이 문서는 Agent Logging Protocol 버전 `1`을 다룹니다. 용어는 [Glossary](GLOSSARY.md)를 따릅니다.

Session Log Event는 Client Adapter Daemon과 Main Server가 함께 쓰는 이벤트 모델입니다. Main Server의 Input Adapter는 Session Log Event를 다른 모델로 변환하지 않고 Core에 넘깁니다.

## 메시지

| 메시지 | 방향 | 설명 |
|---|---|---|
| Batch | Daemon → Main Server | 한 Session의 끝난 Turn 하나 이상에서 나온 Session Log Event 묶음입니다. |
| Ack | Main Server → Daemon | Batch를 처리한 결과입니다. |

모든 메시지는 UTF-8 JSON 객체입니다. Daemon은 Batch 하나를 보내면 그 Ack를 받기 전에 다음 Batch를 보내지 않습니다.

## Batch

```json
{
  "protocol_version": 1,
  "batch_id": "0f7c2d3e-5a41-4b8e-9d0a-2c6f1e7b9a10",
  "source": {
    "agent": "claude-code",
    "plugin_version": "0.1.0",
    "host": "dev-laptop"
  },
  "session": {
    "id": "9b2e...",
    "cwd": "/home/user/my-project"
  },
  "events": []
}
```

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `protocol_version` | integer | O | Agent Logging Protocol의 버전입니다. 지금은 `1`입니다. |
| `batch_id` | string | O | Batch를 보낼 때마다 새로 만드는 id입니다. Ack와 짝을 맞추는 데만 쓰며, 중복 제거에는 쓰지 않습니다. |
| `source.agent` | string | O | 에이전트 id입니다. [Plugin Specification](PLUGIN_SPEC.md#에이전트-id)을 따릅니다. |
| `source.plugin_version` | string | O | Session Log Event를 만든 Plugin의 버전입니다. |
| `source.host` | string | | Daemon이 실행 중인 머신의 이름입니다. |
| `session.id` | string | O | 에이전트가 부여한 session id입니다. |
| `session.cwd` | string | | 에이전트의 작업 디렉터리입니다. |
| `events` | array | O | Session Log Event 목록입니다. Session Log File에 기록된 순서를 따르며, 항상 `user_message`로 시작합니다. |

## Session Log Event

Batch의 `events`에 담는 Session Log Event의 필드와, Core가 Session Log Event로 Turn, Loop, LLM Call, Tool Call을 구성하는 규칙은 [Domain Model](DOMAIN_MODEL.md#session-log-event)에서 정의합니다.

### 알 수 없는 값

Main Server는 모르는 `type`의 Session Log Event, 모르는 `content` 블록, 모르는 필드를 무시합니다. 그래서 같은 `protocol_version` 안에서는 Session Log Event의 종류나 선택 필드를 추가할 수 있습니다.

## Ack

성공:

```json
{
  "protocol_version": 1,
  "batch_id": "0f7c2d3e-5a41-4b8e-9d0a-2c6f1e7b9a10",
  "status": "accepted"
}
```

거절:

```json
{
  "protocol_version": 1,
  "batch_id": "0f7c2d3e-5a41-4b8e-9d0a-2c6f1e7b9a10",
  "status": "rejected",
  "retryable": true,
  "error": { "code": "unavailable", "message": "storage is not ready" }
}
```

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `protocol_version` | integer | O | Main Server가 응답에 쓴 Agent Logging Protocol 버전입니다. |
| `batch_id` | string | O | 응답하는 Batch의 `batch_id`입니다. Batch를 해석하지 못해 알 수 없으면 빈 문자열입니다. |
| `status` | string | O | `accepted` 또는 `rejected`입니다. |
| `retryable` | boolean | 거절일 때 | 같은 Batch를 다시 보내면 성공할 수 있으면 `true`입니다. |
| `error.code` | string | 거절일 때 | 거절 사유 코드입니다. |
| `error.message` | string | | 사람이 읽을 설명입니다. |

### 규칙

- Main Server는 Batch의 Session Log Event를 모두 저장한 뒤에만 `accepted`를 보냅니다.
- 이미 저장된 event id의 Session Log Event는 무시하며, 그런 Session Log Event가 있어도 `accepted`로 응답합니다. 중복 판단의 키는 `source.agent`, `session.id`, `event_id`의 조합입니다.
- Batch 전체는 올바른데 Session Log Event 하나가 잘못되었으면, Main Server는 그 Session Log Event만 로그를 남기고 버린 뒤 나머지를 처리해 `accepted`로 응답합니다.

| `error.code` | `retryable` | 사용하는 경우 |
|---|---|---|
| `invalid_batch` | `false` | JSON이 아니거나 Batch의 필수 필드가 없는 경우 |
| `unsupported_version` | `true` | Main Server가 `protocol_version`을 지원하지 않는 경우. Main Server를 갱신하면 성공할 수 있으므로 재시도할 수 있다고 봅니다. |
| `unavailable` | `true` | 저장소 오류처럼 Main Server 내부 사정으로 처리하지 못한 경우 |

Daemon이 Ack를 받았을 때 하는 일은 [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#ack-처리)을 참고하세요.

## 버전

`protocol_version`은 호환되지 않는 변경이 있을 때만 올립니다. 필드 이름이나 의미를 바꾸거나 필수 필드를 추가하는 것이 호환되지 않는 변경입니다. Session Log Event 종류나 선택 필드를 추가할 때는 올리지 않습니다. Main Server는 지원하는 버전마다 Decoder를 하나씩 둡니다.

## Transport 바인딩

모든 Transport에서 Batch 하나에 Ack 하나가 대응합니다. Daemon은 Ack 타임아웃 안에 Ack를 받지 못하면 재시도 가능한 실패로 처리합니다.

| Transport | 같은 머신 | 원격 |
|---|---|---|
| 표준입출력 | O | X |
| Unix Socket | O | X |
| REST API | O | O |
| Streamable HTTP | O | O |
| WebSocket | O | O |

### 표준입출력

- Daemon이 설정된 Main Server 명령을 자식 프로세스로 실행하고, 그 프로세스의 표준입력과 표준출력으로 통신합니다.
- 메시지 하나를 한 줄의 JSON으로 쓰고 줄바꿈(`\n`)으로 끝냅니다. 메시지 안에는 줄바꿈 문자를 그대로 넣지 않습니다.
- Daemon은 자식 프로세스의 표준입력에 Batch를 쓰고, 표준출력에서 Ack 한 줄을 읽습니다.
- 자식 프로세스의 표준에러는 로그 용도이며 메시지로 해석하지 않습니다.
- 자식 프로세스가 종료되면 그때 보내던 Batch는 재시도 가능한 실패로 처리하고, 다음 Batch를 보낼 때 다시 실행합니다.

### Unix Socket

- Main Server가 설정된 경로에 Unix Socket을 열고 기다립니다.
- 메시지 구분은 표준입출력과 같이 한 줄에 JSON 하나입니다.
- Daemon은 연결 하나로 Batch와 Ack를 차례로 여러 번 주고받을 수 있습니다. 연결이 끊기면 다시 연결합니다.

### REST API

- Daemon은 Batch를 `POST {base_url}/v1/batches`로 보냅니다. `Content-Type`은 `application/json`입니다.
- Main Server는 응답 본문에 Ack를 담고, Ack에 맞는 상태 코드를 씁니다.

| Ack | 상태 코드 |
|---|---|
| `accepted` | `200` |
| `invalid_batch` | `400` |
| `unsupported_version` | `422` |
| `unavailable` | `503` |

- Daemon은 응답 본문의 Ack로 결과를 판단합니다. 본문을 Ack로 해석할 수 없을 때만(예: 앞단 프록시가 만든 오류 응답) 상태 코드로 판단합니다. 이때는 `2xx`를 받아도 성공으로 보지 않습니다.

| 본문을 해석할 수 없을 때의 상태 코드 | Daemon의 판단 |
|---|---|
| `5xx`, `408`, `429`, `2xx` | 재시도 가능한 실패 |
| 그 밖의 `4xx` | 재시도할 수 없는 실패 |

### Streamable HTTP

- Daemon은 Batch를 `POST {base_url}/v1/stream`으로 보냅니다. `Accept`는 `application/json, text/event-stream`입니다.
- Main Server는 Ack를 `application/json` 본문으로 바로 돌려주거나, `text/event-stream`으로 응답을 열고 처리가 끝나면 `event: ack` 이벤트의 `data`에 Ack를 담아 보냅니다. 처리가 오래 걸리면 그동안 SSE 주석 줄로 연결을 유지할 수 있습니다.
- Ack를 보낸 뒤 Main Server는 스트림을 닫습니다.
- 상태 코드 규칙은 REST API와 같습니다.

### WebSocket

- Daemon은 `{base_url}/v1/ws`로 WebSocket 연결을 열고 유지합니다.
- 메시지 하나를 text frame 하나에 담습니다.
- Main Server는 Batch마다 같은 `batch_id`의 Ack를 보냅니다.
- 연결이 끊기면 그때 보내던 Batch는 재시도 가능한 실패로 처리하고, 다음 Batch를 보낼 때 다시 연결합니다.

## 결정되지 않은 사항

- 원격 Transport(REST API, Streamable HTTP, WebSocket)의 인증과 암호화 방식
- Main Server가 받아들이는 Batch 크기의 상한과, 상한을 넘었을 때의 응답
- Session Log Event의 형식에 관한 사항은 [Domain Model](DOMAIN_MODEL.md#결정되지-않은-사항)을 참고하세요.
