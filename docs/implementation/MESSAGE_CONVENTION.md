# MESSAGE_CONVENTION.md

이 문서는 [Agent Logging Protocol](../model/AGENT_LOGGING_PROTOCOL.md) 버전 `1`의 메시지 규약을 정합니다. 메시지를 실어 나르는 방식은 [Transport](TRANSPORT.md)를 참고하세요. 메시지의 필드와 규칙은 model 문서를 따르며, 이 문서는 바꾸지 않습니다. 용어는 [Glossary](../model/GLOSSARY.md)를 따릅니다.

## 메시지 규약

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
