# AGENT_LOGGING_PROTOCOL.md

이 문서는 Client Adapter Daemon과 Main Server가 주고받는 메시지의 형식과 규칙, 그리고 메시지를 실어 나르는 Transport가 지켜야 하는 규칙을 정의합니다. 이 문서는 Agent Logging Protocol 버전 `1`을 다룹니다. 용어는 [Glossary](GLOSSARY.md)를 따릅니다.

Session Log Event는 Client Adapter Daemon과 Main Server가 함께 쓰는 이벤트 모델입니다. Main Server의 Input Adapter는 Session Log Event를 다른 모델로 변환하지 않고 Core에 넘깁니다.

## 메시지

| 메시지 | 방향 | 설명 |
|---|---|---|
| Transport Unit | Daemon → Main Server | 한 Session, 한 Agent의 끝난 Turn에 속한 Session Log 레코드 하나에서 나온 Session Log Event입니다. |
| Ack | Main Server → Daemon | Transport Unit을 처리한 결과입니다. |

Daemon은 Transport Unit 하나를 보내면 그 Ack를 받기 전에 다음 Transport Unit을 보내지 않습니다.

## Transport Unit

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `protocol_version` | integer | O | Agent Logging Protocol의 버전입니다. 지금은 `1`입니다. |
| `transport_unit_id` | string | O | Transport Unit을 보낼 때마다 새로 만드는 id입니다. Ack와 짝을 맞추는 데만 쓰며, 중복 제거에는 쓰지 않습니다. |
| `source.agent` | string | O | 에이전트 id입니다. [Plugin Specification](PLUGIN_SPEC.md#에이전트-id)을 따릅니다. |
| `source.plugin_version` | string | O | Session Log Event를 만든 Plugin의 버전입니다. |
| `source.host` | string | | Daemon이 실행 중인 머신의 이름입니다. |
| `session.id` | string | O | Session ID입니다. Main Agent와 Subagent가 같은 값을 씁니다. 에이전트가 Subagent에 따로 session id를 부여하더라도 Main Agent의 Session ID를 넣습니다. |
| `session.cwd` | string | | 에이전트의 작업 디렉터리입니다. |
| `agent.id` | string | O | `events`를 기록한 Agent의 Agent ID입니다. |
| `agent.parent_id` | string | Subagent일 때 | 부모 Agent ID입니다. Main Agent이면 비웁니다. |
| `turn.id` | string | O | `events`가 속한 Turn을 시작한 `user_message`의 `event_id`입니다. Turn을 시작하는 레코드의 Transport Unit에서는 `events`의 첫 Session Log Event의 `event_id`와 같습니다. |
| `turn.position` | integer | O | `events`의 첫 Session Log Event의 Turn 안 위치입니다. Turn을 시작한 `user_message`가 `0`이며, 그 뒤의 Session Log Event는 Session Log에 기록된 순서대로 하나씩 늘어납니다. |
| `turn.last` | boolean | O | 이 Transport Unit이 그 Turn의 마지막 Transport Unit이면 `true`입니다. |
| `events` | array | O | 레코드 하나에서 나온 Session Log Event 목록입니다. 하나 이상이며, 레코드 안에서 나온 순서를 따릅니다. |

- `events`의 Session Log Event의 Turn 안 위치는 `turn.position`부터 하나씩 늘어납니다.
- Turn 하나는 여러 Transport Unit에 나뉘어 옵니다. 그 Turn의 Transport Unit에서 `turn.position`은 겹치지 않고, `turn.last`가 `true`인 Transport Unit은 하나입니다.

## Session Log Event

Transport Unit의 `events`에 담는 Session Log Event의 필드와, Core가 Session Log Event로 Turn, Loop, LLM Call, Tool Call을 구성하는 규칙은 [Domain Model](DOMAIN_MODEL.md#session-log-event)에서 정의합니다.

### 알 수 없는 값

Main Server는 모르는 `type`의 Session Log Event, 모르는 `content` 블록, 모르는 필드를 무시합니다. 무시한다는 것은 활동 모델을 구성할 때 쓰지 않는다는 뜻이며, 원문은 저장합니다([Data Architecture](DATA_ARCHITECTURE.md#원칙) 참고). 그래서 같은 `protocol_version` 안에서는 Session Log Event의 종류나 선택 필드를 추가할 수 있습니다.

## Ack

Ack는 성공(`accepted`) 또는 거절(`rejected`)입니다.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `protocol_version` | integer | O | Main Server가 응답에 쓴 Agent Logging Protocol 버전입니다. |
| `transport_unit_id` | string | O | 응답하는 Transport Unit의 `transport_unit_id`입니다. Transport Unit을 해석하지 못해 알 수 없으면 빈 문자열입니다. |
| `status` | string | O | `accepted` 또는 `rejected`입니다. |
| `retryable` | boolean | 거절일 때 | 같은 Transport Unit을 다시 보내면 성공할 수 있으면 `true`입니다. |
| `error.code` | string | 거절일 때 | 거절 사유 코드입니다. |
| `error.message` | string | | 사람이 읽을 설명입니다. |

### 규칙

- Main Server는 Transport Unit의 Session Log Event를 모두 저장한 뒤에만 `accepted`를 보냅니다.
- 이미 저장된 event id의 Session Log Event는 무시하며, 그런 Session Log Event가 있어도 `accepted`로 응답합니다. 중복 판단의 키는 `source.agent`, `session.id`, `event_id`의 조합입니다.
- Transport Unit 전체는 올바른데 Session Log Event 하나가 잘못되었으면, Main Server는 그 Session Log Event만 로그를 남기고 버린 뒤 나머지를 처리해 `accepted`로 응답합니다.

| `error.code` | `retryable` | 사용하는 경우 |
|---|---|---|
| `invalid_transport_unit` | `false` | Transport Unit으로 해석할 수 없거나 Transport Unit의 필수 필드가 없는 경우 |
| `unsupported_version` | `true` | Main Server가 `protocol_version`을 지원하지 않는 경우. Main Server를 갱신하면 성공할 수 있으므로 재시도할 수 있다고 봅니다. |
| `unavailable` | `true` | 저장소 오류처럼 Main Server 내부 사정으로 처리하지 못한 경우 |

Daemon이 Ack를 받았을 때 하는 일은 [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#ack-처리)을 참고하세요.

## 버전

`protocol_version`은 호환되지 않는 변경이 있을 때만 올립니다. 필드 이름이나 의미를 바꾸거나 필수 필드를 추가하는 것이 호환되지 않는 변경입니다. Session Log Event 종류나 선택 필드를 추가할 때는 올리지 않습니다. Main Server는 지원하는 버전마다 Decoder를 하나씩 둡니다.

## Transport

Transport는 Daemon이 보낸 Transport Unit을 Main Server에 전달하고, 그 Ack를 Daemon에 돌려주는 방식입니다. 어떤 Transport를 쓰든 다음을 지킵니다.

- Transport Unit 하나에 Ack 하나가 대응합니다.
- Daemon은 Ack 타임아웃 안에 Ack를 받지 못하면 재시도 가능한 실패로 처리합니다.

## 결정되지 않은 사항

- Main Server가 받아들이는 Transport Unit 크기의 상한과, 상한을 넘었을 때의 응답
- Session Log Event의 형식에 관한 사항은 [Domain Model](DOMAIN_MODEL.md#결정되지-않은-사항)을 참고하세요.
