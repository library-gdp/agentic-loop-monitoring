# PLUGIN_SPEC.md

이 문서는 Client Adapter Daemon의 Plugin이 정의하고 지켜야 하는 규칙을 정합니다. Plugin은 에이전트마다 하나씩 두며, 새 에이전트를 지원할 때는 이 문서를 따르는 Plugin을 추가합니다. Daemon이 Plugin이 넘긴 Session Log Event를 어떻게 보내는지는 [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md)을, Plugin이 만드는 Session Log Event의 형식은 [Domain Model](DOMAIN_MODEL.md#session-log-event)을 참고하세요.

## 역할

Plugin은 다음 세 가지를 맡습니다.

1. **Trigger**: 언제 Session Log File을 읽을지 정하고, 그때 읽기를 시작합니다.
2. **읽는 방식**: Session Log File을 찾아 읽고, 어디까지 읽었는지 기록해 다음에 이어 읽습니다.
3. **변환**: 읽은 레코드를 Turn 단위로 묶어 Session Log Event로 변환합니다. 사용자가 중단한 Turn은 걸러냅니다.

Plugin은 Main Server와 통신하거나 재시도를 판단하지 않습니다. 이 일은 Daemon이 맡습니다.

## Daemon에 넣는 방식

Plugin 코드는 Daemon 실행 파일에 함께 빌드합니다. Daemon은 실행 중에 Plugin을 불러오지 않으며, Daemon 설정에서는 실행 파일에 들어 있는 Plugin 가운데 활성화할 것을 고릅니다. 새 에이전트를 지원하거나 Plugin을 고치면 Daemon을 다시 빌드하고 배포합니다. 결정 배경은 [Bundle Plugins into the Client Adapter Daemon executable](../adr/2026-10-22-bundle-plugins-into-daemon-executable.md)을 참고하세요.

Plugin은 TypeScript로 구현합니다([Implement the Client Adapter Daemon and Plugins in TypeScript](../adr/2026-10-22-implement-daemon-and-plugins-in-typescript.md)).

## 에이전트 id

Plugin은 자신이 맡는 에이전트의 id를 하나 가집니다. 에이전트 id는 소문자와 하이픈으로 이루어지며, Daemon 설정의 "사용할 Plugin"과 Session Log Event의 Batch에서 같은 값을 씁니다.

| 에이전트 | 에이전트 id |
|---|---|
| Claude Code | `claude-code` |
| Codex | `codex` |
| OpenCode | `opencode` |

## Plugin이 정의하는 것

Session Log File을 언제, 어떻게 읽을지는 에이전트마다 다릅니다. 에이전트가 외부에 알려 주는 시점도, Session Log File의 형식과 파일 구성도 에이전트마다 다르기 때문입니다. 그래서 Daemon과 이 문서는 Trigger와 읽는 방식을 정하지 않습니다. **각 Plugin이 Trigger와 읽는 방식을 정의해야 하며**, 그 내용을 [에이전트별 문서](#에이전트별-문서)에 적습니다. 어떻게 정의하든 아래 규칙은 지켜야 합니다.

### Trigger

Trigger는 Plugin이 Session Log File 읽기를 시작하는 조건입니다. Plugin은 다음을 정의합니다.

- 무엇을 계기로 읽기를 시작하는지(예: 파일 변경 감시, 주기적 확인, 에이전트가 제공하는 확장 지점)
- Trigger를 쓰려고 에이전트나 머신에 설치하거나 설정해야 하는 것과 그 방법
- Daemon이 꺼져 있는 동안 기록된 내용을 다음에 읽을 수 있는지, 아니면 유실되는지

Trigger는 다음 규칙을 지킵니다.

1. **에이전트를 기다리게 하지 않습니다.** 에이전트의 동작을 막거나 늦추지 않으며, 에이전트가 Plugin의 처리 결과를 기다리지 않게 합니다.
2. **에이전트에 아무것도 주입하지 않습니다.** 에이전트의 컨텍스트나 출력에 영향을 주지 않습니다.
3. **실패해도 에이전트는 정상적으로 동작합니다.** Daemon이 실행 중이지 않거나 Trigger가 실패해도 에이전트의 작업은 멈추지 않습니다.
4. **끝난 Turn을 읽을 기회가 있어야 합니다.** Turn이 끝난 뒤 그 Turn을 읽도록 Trigger가 발동해야 합니다. Session의 마지막 Turn처럼 읽지 못하고 남는 경우가 있으면 에이전트별 문서에 적습니다.

### 읽는 방식

Plugin은 다음을 정의합니다.

- Session Log File의 위치와, 그 파일이 어느 Session의 것인지 알아내는 방법
- 어디까지 읽었는지 나타내고 저장하는 방법, 그리고 다음에 이어 읽는 방법
- Session Log File이 바뀌거나(다른 파일로 교체, 잘림, 삭제 등) 저장해 둔 읽은 위치가 손상되었을 때의 처리
- 한 번에 읽는 범위. 에이전트가 계속 쓰는 동안 파일 끝을 끝없이 따라가지 않도록 범위를 정합니다.

읽기는 다음 규칙을 지킵니다.

1. **읽기만 합니다.** Session Log File을 수정하거나, 잠그거나, 옮기지 않습니다. 네트워크를 쓰지 않습니다. 읽은 위치처럼 Plugin 자신의 상태는 저장할 수 있습니다.
2. **끝난 Turn만 넘깁니다.** 아직 끝나지 않은 Turn은 Daemon에 넘기지 않고, 그 Turn이 끝난 뒤에 처음부터 다시 읽습니다. Turn이 언제 끝나는지는 [Turn 단위](#turn-단위)를 참고하세요. 레코드도 완결된 것만 읽습니다. 레코드가 아직 다 기록되지 않았으면(예: 줄 단위 형식에서 마지막 줄이 줄바꿈으로 끝나지 않음) 그 레코드가 속한 Turn은 끝나지 않은 것으로 봅니다.
3. **모르는 것은 건너뜁니다.** 모르는 종류의 레코드나 모르는 필드는 무시합니다. 완결되었지만 해석할 수 없는 레코드는 로그를 남기고 건너뜁니다.
4. **결정적입니다.** 같은 내용을 다시 읽으면 항상 같은 Session Log Event와 같은 event id를 만듭니다. event id를 만들 때 현재 시각이나 난수를 쓰지 않습니다.
5. **없는 값을 만들지 않습니다.** 에이전트가 기록하지 않은 값은 Session Log Event에서 비워 둡니다. 예를 들어 에이전트가 Cache Write Token을 기록하지 않으면 `0`이 아니라 필드를 빼야 합니다.

읽은 위치를 잃거나 확신할 수 없으면 처음부터 다시 읽어도 됩니다. 이미 보낸 Session Log Event가 다시 가더라도 event id가 같으므로 Main Server가 걸러냅니다.

### Turn 단위

Main Server는 Session Log Event를 항상 끝난 Turn 단위로 받습니다. 그래서 Turn을 나누고 거르는 일은 Plugin이 맡습니다.

Turn은 사용자 프롬프트 레코드에서 시작하며, 다음 중 가장 먼저 나오는 것에서 끝납니다.

| 끝나는 방식 | 판단 기준 | 처리 |
|---|---|---|
| 최종 응답 | 도구 실행을 요청하지 않는 모델 응답이 기록됨 | Turn의 Session Log Event를 Daemon에 넘깁니다. |
| 사용자 중단 | 에이전트가 사용자 중단을 기록함 | Turn 전체를 읽은 것으로 치되 Session Log Event를 만들지 않습니다. |
| 다음 Turn 시작 | 위 두 가지 없이 다음 사용자 프롬프트 레코드가 나옴 | 오류나 충돌로 끝난 Turn으로 보고, 그때까지의 Session Log Event를 넘깁니다. |

- 세 기준을 Session Log File에서 어떻게 알아보는지는 에이전트마다 다르므로 [에이전트별 문서](#에이전트별-문서)에 적습니다. 예를 들어 사용자 중단을 나타내는 레코드가 사용자 프롬프트와 같은 종류로 기록되는 에이전트라면, Plugin은 이를 프롬프트로 다루지 않아야 합니다.
- 에이전트가 사용자 중단을 기록하지 않으면 Plugin은 중단을 알아볼 수 없습니다. 이때 중단된 Turn은 다음 Turn이 시작될 때 오류로 끝난 Turn으로 보내집니다.
- 첫 사용자 프롬프트 앞에 있는 레코드(예: Session 메타데이터)는 Turn에 속하지 않습니다. Session Log Event를 만드는 데 필요한 정보(예: 모델 이름)는 Plugin이 따로 기억해 두고, 이 레코드로 Session Log Event를 만들지 않습니다.

## Daemon과의 관계

- Plugin은 한 Session의 끝난 Turn 단위로 Session Log Event를 Daemon에 넘깁니다. 이때 에이전트가 부여한 session id와, 알 수 있으면 에이전트의 작업 디렉터리를 함께 넘깁니다.
- Daemon은 Session Log Event를 Batch로 묶어 Main Server에 보냅니다. Batch 크기 한도와 재시도는 Daemon이 맡습니다([Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#ack-처리) 참고).
- Plugin은 다른 Plugin이나 Daemon 내부를 직접 부르지 않습니다.

## event id

Plugin은 Session Log Event마다 event id를 붙입니다. Main Server는 이 값으로 중복을 걸러내므로 다음을 지켜야 합니다.

- 같은 Session 안에서 Session Log Event마다 다릅니다.
- 같은 레코드를 다시 읽으면 같은 값이 나옵니다.

에이전트가 레코드마다 고유 id를 기록하면 그 값을 바탕으로 만듭니다. 그렇지 않으면 Session Log File 안에서 레코드의 위치처럼 다시 읽어도 바뀌지 않는 값으로 만듭니다. 레코드 하나에서 Session Log Event가 여러 개 나오면 뒤에 순번을 붙입니다(예: `<레코드 값>:0`, `<레코드 값>:1`).

## 에이전트별 문서

Plugin을 구현할 때 에이전트마다 따로 문서를 만들고 다음을 적습니다.

- **Trigger**: [Trigger](#trigger)에서 Plugin이 정의하는 것
- **읽는 방식**: [읽는 방식](#읽는-방식)에서 Plugin이 정의하는 것
- **Session Log File**: 위치와 형식
- **변환**: 레코드를 Session Log Event로 옮기는 방법과, [Turn 단위](#turn-단위)의 세 기준을 알아보는 방법
- **input 기록 범위**: LLM Call의 input([Glossary](GLOSSARY.md) 참고) 가운데 그 에이전트가 Session Log File에 기록하는 것과 기록하지 않는 것. 기록하지 않는 input은 Plugin이 만들어 내지 않습니다.

## 결정되지 않은 사항

- Plugin이 Session Log Event를 Daemon에 넘기는 TypeScript 인터페이스
- 재시도를 모두 실패한 Batch를 나중에 다시 보내는 방법
- Plugin이 읽은 위치 같은 자신의 상태를 저장하는 위치
- Subagent가 별도의 Session Log File을 쓰는 경우, 부모 Session과 어떻게 연결할지
