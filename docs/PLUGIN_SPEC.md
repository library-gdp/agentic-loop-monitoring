# PLUGIN_SPEC.md

이 문서는 Client Adapter Daemon의 Plugin이 구현해야 하는 인터페이스와 규칙을 정의합니다. Plugin은 에이전트마다 하나씩 두며, 새 에이전트를 지원할 때는 이 문서를 따르는 Plugin을 추가합니다. Daemon이 Plugin을 언제 어떻게 부르는지는 [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md)을, Plugin이 만드는 Wire Event의 형식은 [Wire Protocol](WIRE_PROTOCOL.md)을 참고하세요.

## 역할

Plugin은 다음 세 가지를 맡습니다.

1. Hook payload에서 Session Log File의 위치를 알아냅니다.
2. Session Log File을 주어진 Offset부터 읽습니다.
3. 읽은 레코드를 Turn 단위로 묶어 Wire Event로 변환합니다. 사용자가 중단한 Turn은 걸러냅니다.

Plugin은 Offset을 저장하거나, Main Server와 통신하거나, 재시도를 판단하지 않습니다. 이 일은 Daemon이 맡습니다.

## Daemon에 넣는 방식

Plugin 코드는 Daemon 실행 파일에 함께 빌드합니다. Daemon은 실행 중에 Plugin을 불러오지 않으며, Daemon 설정에서는 실행 파일에 들어 있는 Plugin 가운데 활성화할 것을 고릅니다. 새 에이전트를 지원하거나 Plugin을 고치면 Daemon을 다시 빌드하고 배포합니다. 결정 배경은 [Bundle Plugins into the Client Adapter Daemon executable](../adr/2026-10-22-bundle-plugins-into-daemon-executable.md)을 참고하세요.

## 에이전트 id

Plugin은 자신이 맡는 에이전트의 id를 하나 가집니다. 에이전트 id는 소문자와 하이픈으로 이루어지며, Hook Client의 인자, Signal, Offset Store, Wire Event의 Batch에서 같은 값을 씁니다.

| 에이전트 | 에이전트 id |
|---|---|
| Claude Code | `claude-code` |
| Codex | `codex` |
| OpenCode | `opencode` |

## 인터페이스

Plugin은 TypeScript로 구현합니다([Implement the Client Adapter Daemon and Plugins in TypeScript](../adr/2026-10-22-implement-daemon-and-plugins-in-typescript.md)). 아래 인터페이스는 언어와 무관한 표기로 적었으며, 구현할 때 TypeScript 타입으로 옮깁니다.

```
Plugin
  agent: string
  resolve(hook_payload: string) -> SessionLogRef
  mark_end(ref: SessionLogRef) -> EndMark
  read(ref: SessionLogRef, cursor: Cursor, end: EndMark, limit: ReadLimit) -> ReadResult

SessionLogRef
  session_id: string        # 에이전트가 부여한 session id
  path: string              # Session Log File의 절대 경로
  cwd: string?              # 에이전트의 작업 디렉터리. 알 수 없으면 비움

Cursor
  offset: integer           # 읽기 시작할 바이트 위치
  state: any?               # 직전 read가 돌려준 Plugin State. 처음이면 비움

EndMark: any               # 이번 Signal 처리에서 읽을 끝 위치. Plugin이 정하며 Daemon은 해석하지 않음

ReadLimit
  max_events: integer       # 돌려줄 Wire Event 수의 최댓값
  max_bytes: integer        # 소비할 바이트 수의 최댓값

ReadResult
  events: WireEvent[]       # 변환한 Wire Event. 순서는 Session Log File의 순서를 따름
  next: Cursor              # 소비한 마지막 Turn의 바로 다음 위치와 다음 Plugin State
```

### resolve

Hook payload 원문을 해석해 Session Log File을 알아냅니다.

- Hook payload에 Session Log File의 경로가 있으면 그 값을 씁니다. 없으면 session id 같은 값으로 에이전트의 규칙에 따라 경로를 찾습니다.
- session id는 반드시 돌려줍니다. Daemon은 에이전트 id와 session id로 Offset을 저장합니다.
- 경로는 절대 경로로 돌려줍니다.
- Hook payload를 해석할 수 없거나 Session Log File을 찾을 수 없으면 오류를 돌려줍니다. Daemon은 로그를 남기고 Signal을 버립니다.
- Session Log File을 읽지 않습니다. `resolve`는 Signal을 받을 때마다 불리므로 빨리 끝나야 합니다.

### mark_end

이번 Signal 처리에서 읽을 끝 위치를 정합니다. Daemon은 Signal 처리를 시작할 때 한 번 부르고, 돌려받은 값을 그 Signal의 모든 `read`에 `end`로 넘깁니다.

- 끝 위치를 어떻게 나타낼지는 Plugin이 정합니다. 예를 들어 덧붙여 쓰는 파일 하나에 기록하는 에이전트라면 그 시점의 파일 크기를 돌려줄 수 있습니다.
- Daemon은 `EndMark`를 해석하지도, 저장하지도 않습니다. 그 Signal의 처리가 끝나면 버립니다.
- 레코드를 해석하지 않습니다. 파일 크기를 확인하는 것처럼 빨리 끝나는 일만 합니다.
- Session Log File을 찾을 수 없으면 오류를 돌려줍니다. Daemon은 로그를 남기고 Signal을 버립니다.

### read

`cursor.offset`부터 Session Log File을 읽어 Wire Event로 변환합니다.

1. **읽기만 합니다.** Session Log File을 수정하거나, 잠그거나, 옮기지 않습니다. 네트워크를 쓰지 않고, Session Log File 말고 다른 파일에 쓰지 않습니다.
2. **끝난 Turn까지만 소비합니다.** `next.offset`은 항상 Turn의 경계입니다. 아직 끝나지 않은 Turn은 소비하지 않고 그 Turn의 시작에서 멈추며, 다음 `read`에서 처음부터 다시 읽습니다. Turn이 언제 끝나는지는 [Turn 단위](#turn-단위)를 참고하세요. 레코드도 완결된 것만 읽습니다. 파일 끝에서 레코드가 완결되지 않았으면(예: 줄 단위 형식에서 마지막 줄이 줄바꿈으로 끝나지 않음) 그 레코드가 속한 Turn은 끝나지 않은 것으로 봅니다.
3. **끝 위치를 넘지 않습니다.** `end`가 가리키는 위치를 파일 끝으로 봅니다. 파일이 그 뒤로 더 길어졌어도 읽지 않으며, 끝 위치에 걸쳐 있는 레코드는 완결되지 않은 것으로 봅니다.
4. **한도를 지킵니다.** `limit.max_events`와 `limit.max_bytes`를 넘기 전에 멈춥니다. 다만 Turn 하나가 한도보다 크면 그 Turn 하나만 소비하고 멈춥니다. Turn을 나누지 않으며, 같은 위치에서 영원히 멈춰 있지도 않기 위해서입니다.
5. **모르는 것은 건너뜁니다.** 모르는 종류의 레코드나 모르는 필드는 무시하고 소비합니다. 완결되었지만 해석할 수 없는 레코드는 로그를 남기고 건너뛰며, 역시 소비한 것으로 칩니다.
6. **결정적입니다.** 같은 파일 내용과 같은 `cursor`가 주어지면 항상 같은 `events`와 `next`를 돌려줍니다. event id를 만들 때 현재 시각이나 난수를 쓰지 않습니다.
7. **없는 값을 만들지 않습니다.** 에이전트가 기록하지 않은 값은 Wire Event에서 비워 둡니다. 예를 들어 에이전트가 Cache Write Token을 기록하지 않으면 `0`이 아니라 필드를 빼야 합니다.

읽을 것이 없으면 `events`는 비어 있고 `next`는 `cursor`와 같습니다.

### Turn 단위

Main Server는 Wire Event를 항상 끝난 Turn 단위로 받습니다. 그래서 Turn을 나누고 거르는 일은 Plugin이 맡습니다.

Turn은 사용자 프롬프트 레코드에서 시작하며, 다음 중 가장 먼저 나오는 것에서 끝납니다.

| 끝나는 방식 | 판단 기준 | 처리 |
|---|---|---|
| 최종 응답 | 도구 실행을 요청하지 않는 모델 응답이 기록됨 | Turn의 Wire Event를 돌려줍니다. |
| 사용자 중단 | 에이전트가 사용자 중단을 기록함 | Turn 전체를 소비하되 Wire Event를 만들지 않습니다. |
| 다음 Turn 시작 | 위 두 가지 없이 다음 사용자 프롬프트 레코드가 나옴 | 오류나 충돌로 끝난 Turn으로 보고, 그때까지의 Wire Event를 돌려줍니다. |

- 세 기준을 Session Log File에서 어떻게 알아보는지는 에이전트마다 다르므로 [에이전트별 문서](#에이전트별-문서)에 적습니다. 예를 들어 사용자 중단을 나타내는 레코드가 사용자 프롬프트와 같은 종류로 기록되는 에이전트라면, Plugin은 이를 프롬프트로 다루지 않아야 합니다.
- 에이전트가 사용자 중단을 기록하지 않으면 Plugin은 중단을 알아볼 수 없습니다. 이때 중단된 Turn은 다음 Turn이 시작될 때 오류로 끝난 Turn으로 보내집니다.
- 첫 사용자 프롬프트 앞에 있는 레코드(예: Session 메타데이터)는 Turn에 속하지 않습니다. 필요한 정보는 Plugin State에 담고 Wire Event로 만들지 않습니다.

### Plugin State

Wire Event를 만드는 데 앞쪽 레코드의 정보가 필요할 수 있습니다. 예를 들어 모델 이름이 Session Log File 앞부분에 한 번만 기록되는 에이전트가 있습니다. 이런 정보는 `next.state`에 담아 돌려줍니다.

- Daemon은 `next.state`를 해석하지 않고 Offset과 함께 Offset Store에 저장했다가, 다음 `read`의 `cursor.state`로 넘깁니다.
- JSON으로 직렬화할 수 있어야 하며, 작게 유지합니다. 읽은 레코드를 쌓아 두는 용도로 쓰지 않습니다.
- Session Log File이 바뀌었는지(경로 변경, 다른 파일로 교체, 잘림 등) 판단하는 데 필요한 정보도 Plugin State에 담습니다. Daemon은 파일 정보를 기록하지 않으므로, 어떤 정보를 담고 어떻게 판단할지는 Plugin이 정합니다. 바뀌었다고 판단하면 `cursor`를 무시하고 파일 처음부터 읽습니다.
- `cursor.state`가 비어 있고 `cursor.offset`이 0보다 크면, Plugin은 필요한 정보를 얻기 위해 파일 앞부분을 다시 읽을 수 있습니다. 이렇게 읽은 레코드로는 Wire Event를 만들지 않습니다.

## event id

Plugin은 Wire Event마다 event id를 붙입니다. Main Server는 이 값으로 중복을 걸러내므로 다음을 지켜야 합니다.

- 같은 Session 안에서 Wire Event마다 다릅니다.
- 같은 레코드를 다시 읽으면 같은 값이 나옵니다.

에이전트가 레코드마다 고유 id를 기록하면 그 값을 바탕으로 만듭니다. 그렇지 않으면 레코드가 시작하는 바이트 위치를 씁니다. 레코드 하나에서 Wire Event가 여러 개 나오면 뒤에 순번을 붙입니다(예: `48213:0`, `48213:1`).

## 에이전트별 문서

에이전트별 Session Log File의 위치와 형식, Hook payload의 형식, 레코드를 Wire Event로 옮기는 방법은 Plugin을 구현할 때 에이전트마다 따로 문서로 정리합니다. 이 문서에는 LLM Call의 input([Glossary](GLOSSARY.md) 참고) 가운데 그 에이전트가 Session Log File에 기록하는 것과 기록하지 않는 것도 적습니다. 기록하지 않는 input은 Plugin이 만들어 내지 않습니다.

## 결정되지 않은 사항

- Session Log File이 한 파일에 덧붙여 쓰는 형식이 아닌 에이전트를 어떻게 다룰지. 바이트 Offset은 덧붙여 쓰는 파일을 전제로 합니다.
- Subagent가 별도의 Session Log File을 쓰는 경우, 부모 Session과 어떻게 연결할지
