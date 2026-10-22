# WIRE_PROTOCOL.md

이 문서는 Client Adapter Daemon과 Main Server가 주고받는 메시지의 형식과, Transport별로 메시지를 실어 나르는 방식을 정의합니다. 이 문서는 Wire Protocol 버전 `1`을 다룹니다. 용어는 [Glossary](GLOSSARY.md)를 따릅니다.

Wire Event는 전송 형식입니다. Main Server의 Input Adapter가 Wire Event를 Core의 Canonical Event로 변환하며, Canonical Event 모델은 Core에서 따로 정의합니다.

## 메시지

| 메시지 | 방향 | 설명 |
|---|---|---|
| Batch | Daemon → Main Server | 한 Session의 끝난 Turn 하나 이상에서 나온 Wire Event 묶음입니다. |
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
| `protocol_version` | integer | O | Wire Protocol의 버전입니다. 지금은 `1`입니다. |
| `batch_id` | string | O | Batch를 보낼 때마다 새로 만드는 id입니다. Ack와 짝을 맞추는 데만 쓰며, 중복 제거에는 쓰지 않습니다. |
| `source.agent` | string | O | 에이전트 id입니다. [Plugin Specification](PLUGIN_SPEC.md#에이전트-id)을 따릅니다. |
| `source.plugin_version` | string | O | Wire Event를 만든 Plugin의 버전입니다. |
| `source.host` | string | | Daemon이 실행 중인 머신의 이름입니다. |
| `session.id` | string | O | 에이전트가 부여한 session id입니다. |
| `session.cwd` | string | | 에이전트의 작업 디렉터리입니다. |
| `events` | array | O | Wire Event 목록입니다. Session Log File에 기록된 순서를 따르며, 항상 `user_message`로 시작합니다. |

## Wire Event

### 공통 필드

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `event_id` | string | O | Plugin이 붙인 event id입니다. `source.agent`와 `session.id`가 같은 범위 안에서 고유하며, 같은 레코드를 다시 읽어도 바뀌지 않습니다. |
| `type` | string | O | Wire Event의 종류입니다. |
| `timestamp` | string | O | 에이전트가 레코드를 기록한 시각입니다. RFC 3339 형식이며 시간대를 포함합니다. |

Wire Event는 Turn이나 Loop를 직접 나타내지 않습니다. Core가 같은 Session의 Wire Event 순서와 연결 관계로 Turn, Loop, LLM Call, Tool Call을 구성합니다. LLM Call의 input도 따로 보내지 않으며, Core가 그 LLM Call 앞의 Wire Event로 구성합니다.

버전 `1`로 구성할 수 있는 LLM Call의 input은 [Glossary](GLOSSARY.md)가 정의하는 **모든 것**입니다. 시스템 프롬프트, 지침 파일, Skill, 도구 정의, compaction 결과, Subagent에 넘긴 프롬프트, 사용자 메시지, 이전 모델 응답, 도구 결과가 모두 포함됩니다. 이 문서는 아직 이 가운데 사용자 메시지, 모델 응답, 도구 결과의 Wire Event만 정의합니다. 나머지도 버전 `1` 안에서 Wire Event 종류나 선택 필드로 추가합니다([버전](#버전) 참고). 에이전트가 기록하지 않아 Plugin이 얻을 수 없는 input은 보내지 않습니다.

### Turn의 경계

Batch는 끝난 Turn만 담으며, Turn 하나가 여러 Batch에 나뉘지 않습니다. 사용자가 중단한 Turn은 Plugin이 걸러내므로 보내지 않습니다([Plugin Specification](PLUGIN_SPEC.md#turn-단위) 참고).

그래서 Core는 Batch 안에서 Turn을 나눕니다.

- `user_message`가 Turn을 시작합니다.
- Turn은 다음 `user_message` 바로 앞이나 Batch의 끝에서 끝납니다.
- Turn의 마지막 Wire Event가 `tool_use` 블록이 없는 `assistant_message`(최종 응답)이면 정상적으로 끝난 Turn입니다. 그렇지 않으면 오류나 충돌로 끝난 Turn입니다.

Core는 진행 중인 Turn을 두지 않습니다.

### `user_message`

사용자가 입력한 프롬프트입니다. Turn은 `user_message`에서 시작합니다.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `text` | string | O | 프롬프트 원문입니다. |

### `assistant_message`

LLM Call 한 번의 응답입니다.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `model` | string | | 응답한 모델의 이름입니다. |
| `content` | array | O | 응답 내용 블록의 목록입니다. 아래 표를 참고하세요. |
| `usage` | object | | 이 LLM Call의 Token Usage입니다. 아래 표를 참고하세요. |
| `started_at` | string | | 모델에 요청한 시각입니다. 에이전트가 기록할 때만 넣습니다. |

`timestamp`는 응답이 기록된 시각입니다. `started_at`이 없으면 Core가 앞선 Wire Event의 시각으로 LLM Call의 Duration을 추정합니다.

`content` 블록:

| `type` | 필드 | 설명 |
|---|---|---|
| `text` | `text`: string | 모델이 출력한 텍스트입니다. |
| `reasoning` | `text`: string | 모델의 reasoning입니다. 에이전트가 원문을 기록하지 않으면 블록을 넣지 않습니다. |
| `tool_use` | `tool_use_id`: string, `name`: string, `input`: object | 모델이 요청한 도구 실행입니다. `tool_use_id`는 이 요청을 `tool_result`와 잇는 값입니다. |

`usage` 필드는 모두 0 이상의 integer이며 선택입니다. 에이전트가 기록하지 않은 항목은 `0`으로 채우지 않고 뺍니다. 각 항목의 의미는 [Glossary](GLOSSARY.md#metric)를 따릅니다.

| 필드 | 설명 |
|---|---|
| `input_tokens` | Input Token |
| `output_tokens` | Output Token |
| `cache_read_tokens` | Cache Read Token |
| `cache_write_tokens` | Cache Write Token |
| `reasoning_tokens` | Reasoning Token |

### `tool_result`

Tool Call의 실행 결과입니다. `timestamp`는 결과가 기록된 시각입니다.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `tool_use_id` | string | O | 이 결과를 요청한 `tool_use` 블록의 `tool_use_id`입니다. |
| `output` | string 또는 object | O | 도구가 돌려준 결과입니다. |
| `is_error` | boolean | | 도구 실행이 실패했으면 `true`입니다. 에이전트가 기록하지 않으면 뺍니다. |

### 알 수 없는 값

Main Server는 모르는 `type`의 Wire Event, 모르는 `content` 블록, 모르는 필드를 무시합니다. 그래서 같은 `protocol_version` 안에서는 Wire Event의 종류나 선택 필드를 추가할 수 있습니다.

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
| `protocol_version` | integer | O | Main Server가 응답에 쓴 Wire Protocol 버전입니다. |
| `batch_id` | string | O | 응답하는 Batch의 `batch_id`입니다. Batch를 해석하지 못해 알 수 없으면 빈 문자열입니다. |
| `status` | string | O | `accepted` 또는 `rejected`입니다. |
| `retryable` | boolean | 거절일 때 | 같은 Batch를 다시 보내면 성공할 수 있으면 `true`입니다. |
| `error.code` | string | 거절일 때 | 거절 사유 코드입니다. |
| `error.message` | string | | 사람이 읽을 설명입니다. |

### 규칙

- Main Server는 Batch의 Wire Event를 모두 저장한 뒤에만 `accepted`를 보냅니다.
- 이미 저장된 event id의 Wire Event는 무시하며, 그런 Wire Event가 있어도 `accepted`로 응답합니다. 중복 판단의 키는 `source.agent`, `session.id`, `event_id`의 조합입니다.
- Batch 전체는 올바른데 Wire Event 하나가 잘못되었으면, Main Server는 그 Wire Event만 로그를 남기고 버린 뒤 나머지를 처리해 `accepted`로 응답합니다.

| `error.code` | `retryable` | 사용하는 경우 |
|---|---|---|
| `invalid_batch` | `false` | JSON이 아니거나 Batch의 필수 필드가 없는 경우 |
| `unsupported_version` | `true` | Main Server가 `protocol_version`을 지원하지 않는 경우. Main Server를 갱신하면 성공할 수 있으므로 재시도할 수 있다고 봅니다. |
| `unavailable` | `true` | 저장소 오류처럼 Main Server 내부 사정으로 처리하지 못한 경우 |

Daemon이 Ack를 받았을 때 하는 일은 [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#ack-처리)을 참고하세요.

## 버전

`protocol_version`은 호환되지 않는 변경이 있을 때만 올립니다. 필드 이름이나 의미를 바꾸거나 필수 필드를 추가하는 것이 호환되지 않는 변경입니다. Wire Event 종류나 선택 필드를 추가할 때는 올리지 않습니다. Main Server는 지원하는 버전마다 Decoder를 하나씩 둡니다.

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
- 에이전트의 원본 레코드를 Wire Event에 함께 실을지 여부
- Subagent를 부모 Tool Call과 잇는 필드
- 버전 `1`에서 시스템 프롬프트, 지침 파일, Skill, 도구 정의, compaction 결과, Subagent에 넘긴 프롬프트를 나타내는 Wire Event의 형식
