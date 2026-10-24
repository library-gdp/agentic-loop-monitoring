# AGENT_LOGGING_PROTOCOL.md

이 문서는 [Agent Logging Protocol](../model/AGENT_LOGGING_PROTOCOL.md) 버전 `1`의 메시지를 어떻게 인코딩하고, Transport별로 어떻게 실어 나르는지 정합니다. 메시지의 필드와 규칙은 model 문서를 따르며, 이 문서는 바꾸지 않습니다. 용어는 [Glossary](../model/GLOSSARY.md)를 따릅니다.

## 인코딩

모든 메시지는 UTF-8 JSON 객체입니다. 필드 이름은 [Agent Logging Protocol](../model/AGENT_LOGGING_PROTOCOL.md)과 [Domain Model](../model/DOMAIN_MODEL.md#session-log-event)의 필드 이름을 그대로 씁니다. 시각은 RFC 3339 형식의 string으로 쓰며 시간대를 포함합니다.

### Batch

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

### Ack

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

JSON으로 해석할 수 없는 Batch는 `invalid_batch`로 거절합니다.

## Transport 바인딩

모든 Transport는 model 문서의 [Transport](../model/AGENT_LOGGING_PROTOCOL.md#transport) 규칙을 지킵니다. 쓸 수 있는 Transport는 Main Server의 실행 위치에 따라 다릅니다.

| Transport | 같은 머신 | 원격 |
|---|---|---|
| 표준입출력 | O | X |
| Unix Socket | O | X |
| REST API | O | O |
| Streamable HTTP | O | O |
| WebSocket | O | O |

표준입출력과 Unix Socket은 같은 머신의 프로세스끼리만 연결할 수 있습니다. 표준입출력은 Daemon과 Main Server를 1:1로 연결합니다. 나머지 Transport로는 여러 머신의 Daemon이 Main Server 하나에 데이터를 보낼 수 있습니다.

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
