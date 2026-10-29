# PLUGIN_SPEC.md

이 문서는 Client Adapter Daemon의 Plugin이 정의하고 지켜야 하는 규칙을 정합니다. Plugin은 에이전트마다 하나씩 두며, 새 에이전트를 지원할 때는 이 문서를 따르는 Plugin을 추가합니다. Daemon이 Plugin이 넘긴 Session Log Event를 어떻게 보내는지는 [Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md)을, Plugin이 만드는 Session Log Event의 형식은 [Domain Model](DOMAIN_MODEL.md#session-log-event)을 참고하세요.

## 역할

Plugin은 다음 네 가지를 맡습니다.

1. **Trigger**: 언제 Session Log를 수집할지 정하고, 그때 수집을 시작합니다.
2. **수집 방식**: Session Log를 찾아 수집하고, 어디까지 수집했는지 기록해 다음에 이어 수집합니다.
3. **변환**: 수집한 레코드를 Turn 단위로 묶어 Session Log Event로 변환합니다. 사용자가 중단한 Turn은 걸러냅니다.
4. **Batch 구성**: 변환한 Session Log Event를 Batch 단위로 묶어 Daemon에 넘깁니다.

Plugin은 Main Server와 통신하거나 재시도를 판단하지 않습니다. 이 일은 Daemon이 맡습니다.

## 에이전트 id

Plugin은 자신이 맡는 에이전트의 id를 하나 가집니다. 에이전트 id는 소문자와 하이픈으로 이루어지며, Daemon 설정의 "사용할 Plugin"과 Session Log Event의 Batch에서 같은 값을 씁니다.

| 에이전트 | 에이전트 id |
|---|---|
| Claude Code | `claude-code` |
| Codex | `codex` |
| OpenCode | `opencode` |

에이전트 id는 에이전트의 종류를 나타내며, Session 안의 Agent를 식별하는 Agent ID([Glossary](GLOSSARY.md#식별자) 참고)와 다릅니다.

## Session ID와 Agent ID

Plugin은 Session Log에서 Agent마다 Session ID, Agent ID, 부모 Agent ID를 알아내 Session Log Event와 함께 Daemon에 넘깁니다. 각 값이 Session Log의 어디에 기록되는지는 에이전트마다 다르므로 [에이전트별 문서](#에이전트별-문서)에 적습니다. 어떻게 알아내든 다음을 지킵니다.

1. **Session ID는 Session의 모든 Agent가 같습니다.** 사용자가 대화를 처음 시작할 때 만들어진 Session ID를 씁니다. 에이전트가 Subagent에 따로 session id를 부여하더라도, 그 값이 아니라 Main Agent의 Session ID를 넘깁니다.
2. **Agent ID는 Session 안에서 Agent마다 다르고, 다시 수집해도 바뀌지 않습니다.**
3. **부모 Agent ID는 자신을 띄운 Agent의 Agent ID입니다.** Main Agent는 부모 Agent ID를 비웁니다. Subagent의 부모 Agent는 Main Agent일 수도 있고 다른 Subagent일 수도 있습니다.
4. **Subagent의 Session Log도 수집합니다.** 에이전트가 Subagent의 Session Log를 Main Agent와 따로 기록하면 Plugin은 그것도 찾아 수집합니다.

## Plugin이 정의하는 것

Session Log를 언제, 어떻게 수집할지는 에이전트마다 다릅니다. 에이전트가 외부에 알려 주는 시점도, Session Log를 기록하는 곳과 형식, 구성도 에이전트마다 다르기 때문입니다. 한 번에 수집하는 Turn의 수와 크기도 그에 따라 달라집니다. 그래서 Daemon과 이 문서는 Trigger, 수집 방식, Batch 단위를 정하지 않습니다. **각 Plugin이 Trigger, 수집 방식, Batch 단위를 정의해야 하며**, 그 내용을 [에이전트별 문서](#에이전트별-문서)에 적습니다. 어떻게 정의하든 아래 규칙은 지켜야 합니다.

### Trigger

Trigger는 Plugin이 Session Log 수집을 시작하는 조건입니다. Plugin은 다음을 정의합니다.

- 무엇을 계기로 수집을 시작하는지(예: Session Log 변경 감지, 주기적 확인, 에이전트가 제공하는 확장 지점)
- Trigger를 쓰려고 에이전트나 머신에 설치하거나 설정해야 하는 것과 그 방법
- Daemon이 꺼져 있는 동안 기록된 내용을 다음에 수집할 수 있는지, 아니면 유실되는지

Trigger는 다음 규칙을 지킵니다.

1. **에이전트를 기다리게 하지 않습니다.** 에이전트의 동작을 막거나 늦추지 않으며, 에이전트가 Plugin의 처리 결과를 기다리지 않게 합니다.
2. **에이전트에 아무것도 주입하지 않습니다.** 에이전트의 컨텍스트나 출력에 영향을 주지 않습니다.
3. **실패해도 에이전트는 정상적으로 동작합니다.** Daemon이 실행 중이지 않거나 Trigger가 실패해도 에이전트의 작업은 멈추지 않습니다.
4. **끝난 Turn을 수집할 기회가 있어야 합니다.** Turn이 끝난 뒤 그 Turn을 수집하도록 Trigger가 발동해야 합니다. Session의 마지막 Turn처럼 수집하지 못하고 남는 경우가 있으면 에이전트별 문서에 적습니다.

### 수집 방식

Plugin은 다음을 정의합니다.

- Session Log를 어디서 가져오는지와, 그 Session Log가 어느 Session의 것인지 알아내는 방법
- 어디까지 수집했는지 나타내고 저장하는 방법, 그리고 다음에 이어 수집하는 방법
- Session Log가 바뀌거나(다른 것으로 교체, 일부 또는 전체 삭제 등) 저장해 둔 수집 위치가 손상되었을 때의 처리
- 한 번에 수집하는 범위. 에이전트가 계속 기록하는 동안 Session Log의 끝을 끝없이 따라가지 않도록 범위를 정합니다.

수집은 다음 규칙을 지킵니다.

1. **읽기만 합니다.** Session Log를 수정하거나, 잠그거나, 옮기지 않습니다. 네트워크를 쓰지 않습니다. 수집한 위치처럼 Plugin 자신의 상태는 저장할 수 있습니다.
2. **끝난 Turn만 넘깁니다.** 아직 끝나지 않은 Turn은 Daemon에 넘기지 않고, 그 Turn이 끝난 뒤에 처음부터 다시 수집합니다. Turn이 언제 끝나는지는 [Turn 단위](#turn-단위)를 참고하세요. 레코드도 완결된 것만 수집합니다. 레코드가 아직 다 기록되지 않았으면 그 레코드가 속한 Turn은 끝나지 않은 것으로 봅니다.
3. **모르는 것은 건너뜁니다.** 모르는 종류의 레코드나 모르는 필드는 무시합니다. 완결되었지만 해석할 수 없는 레코드는 로그를 남기고 건너뜁니다.
4. **결정적입니다.** 같은 내용을 다시 수집하면 항상 같은 Session Log Event와 같은 event id를 만듭니다. event id를 만들 때 현재 시각이나 난수를 쓰지 않습니다.
5. **없는 값을 만들지 않습니다.** 에이전트가 기록하지 않은 값은 Session Log Event에서 비워 둡니다. 예를 들어 에이전트가 Cache Write Token을 기록하지 않으면 `0`이 아니라 필드를 빼야 합니다.

수집한 위치를 잃거나 확신할 수 없으면 처음부터 다시 수집해도 됩니다. 이미 보낸 Session Log Event가 다시 가더라도 event id가 같으므로 Main Server가 걸러냅니다.

### Turn 단위

Main Server는 Session Log Event를 항상 끝난 Turn 단위로 받습니다. 그래서 Turn을 나누고 거르는 일은 Plugin이 맡습니다.

Plugin은 Agent마다 따로 Turn을 나눕니다. Turn은 프롬프트 레코드에서 시작합니다. Main Agent에서는 사용자 프롬프트 레코드이고, Subagent에서는 부모 Agent가 넘긴 프롬프트 레코드입니다. Turn은 다음 중 가장 먼저 나오는 것에서 끝납니다.

| 끝나는 방식 | 판단 기준 | 처리 |
|---|---|---|
| 최종 응답 | 도구 실행을 요청하지 않는 모델 응답이 기록됨. LLM 호출 오류는 최종 응답이 아닙니다. | Turn의 Session Log Event를 Daemon에 넘깁니다. |
| LLM 호출 오류로 멈춤 | 에이전트가 LLM 호출 오류 뒤 다시 시도하지 않고 Turn을 멈췄다고 기록함 | Turn의 Session Log Event를 Daemon에 넘깁니다. |
| 요청한 compaction 완료 | 사용자가 compaction만 요청한 프롬프트에서, compaction 결과가 기록됨 | Turn의 Session Log Event를 Daemon에 넘깁니다. |
| 사용자 중단 | 에이전트가 사용자 중단을 기록함 | Turn 전체를 수집한 것으로 치되 Session Log Event를 만들지 않습니다. |
| 다음 Turn 시작 | 위 네 가지 없이 다음 사용자 프롬프트 레코드가 나옴 | 오류나 충돌로 끝난 Turn으로 보고, 그때까지의 Session Log Event를 넘깁니다. |

- 이 기준들을 Session Log에서 어떻게 알아보는지는 에이전트마다 다르므로 [에이전트별 문서](#에이전트별-문서)에 적습니다. 예를 들어 사용자 중단을 나타내는 레코드가 사용자 프롬프트와 같은 종류로 기록되는 에이전트라면, Plugin은 이를 프롬프트로 다루지 않아야 합니다.
- 에이전트가 compaction이나 LLM 호출 오류, 재시도를 처리하면서 사용자 프롬프트와 같은 종류로 기록한 레코드(예: compaction 요약, 작업을 이어 가라는 지시)도 프롬프트로 다루지 않습니다. 이런 레코드는 Turn을 시작하지 않으며, 담긴 내용은 해당하는 Session Log Event(예: `compaction`의 `summary`)로 옮깁니다.
- 에이전트가 사용자 중단을 기록하지 않으면 Plugin은 중단을 알아볼 수 없습니다. 이때 중단된 Turn은 다음 Turn이 시작될 때 오류로 끝난 Turn으로 보내집니다.
- 첫 사용자 프롬프트 앞에 있는 레코드(예: Session 메타데이터)는 Turn에 속하지 않습니다. Session Log Event를 만드는 데 필요한 정보(예: 모델 이름)는 Plugin이 따로 기억해 두고, 이 레코드로 Session Log Event를 만들지 않습니다.

### Batch 단위

Batch는 Main Server에 한 번에 보내는 Session Log Event 묶음입니다. Plugin이 Session Log Event를 Batch 단위로 묶어 Daemon에 넘기면, Daemon은 이를 합치거나 나누지 않고 Batch 하나로 보냅니다. Plugin은 다음을 정의합니다.

- 끝난 Turn을 어떻게 Batch로 묶는지(예: Turn마다 Batch 하나, 한 번 수집한 범위에서 Agent마다 Batch 하나)
- Batch 하나에 담는 Session Log Event 수와 바이트 수의 최댓값

Batch는 다음 규칙을 지킵니다.

1. **한 Session, 한 Agent의 Session Log Event만 담습니다.** 같은 Session이라도 Main Agent와 Subagent의 Session Log Event는 다른 Batch에 담습니다.
2. **끝난 Turn을 하나 이상 온전히 담습니다.** Turn 하나를 여러 Batch에 나누지 않으므로, Batch는 항상 Turn의 시작에서 시작합니다.
3. **Session Log에 기록된 순서를 따릅니다.** Batch 안의 Session Log Event는 Session Log에 기록된 순서대로 담습니다.
4. **최댓값을 넘지 않습니다.** 다만 Turn 하나가 최댓값보다 크면 그 Turn만 담아 넘깁니다.

## Daemon과의 관계

- Plugin은 [Batch 단위](#batch-단위)로 묶은 Session Log Event를 Daemon에 넘깁니다. 이때 [Session ID와 Agent ID](#session-id와-agent-id)에서 알아낸 Session ID, Agent ID, 부모 Agent ID와, 알 수 있으면 에이전트의 작업 디렉터리를 함께 넘깁니다.
- Daemon은 Plugin이 넘긴 묶음을 그대로 Batch 하나로 Main Server에 보냅니다. 재시도는 Daemon이 맡습니다([Client Adapter Daemon](CLIENT_ADAPTER_DAEMON.md#ack-처리) 참고).
- Plugin은 다른 Plugin이나 Daemon 내부를 직접 부르지 않습니다.

## event id

Plugin은 Session Log Event마다 event id를 붙입니다. Main Server는 이 값으로 중복을 걸러내므로 다음을 지켜야 합니다.

- 같은 Session 안에서 Session Log Event마다 다릅니다. Session은 Main Agent와 Subagent가 함께 쓰므로, 다른 Agent의 Session Log Event와도 겹치지 않아야 합니다.
- 같은 레코드를 다시 수집하면 같은 값이 나옵니다.

에이전트가 레코드마다 고유 id를 기록하면 그 값을 바탕으로 만듭니다. 그렇지 않으면 Session Log 안에서 레코드의 위치처럼 다시 수집해도 바뀌지 않는 값으로 만듭니다. 레코드의 위치처럼 Agent마다 겹칠 수 있는 값으로 만들면 앞에 Agent ID를 붙입니다(예: `<Agent ID>:<레코드 위치>`). 레코드 하나에서 Session Log Event가 여러 개 나오면 뒤에 순번을 붙입니다(예: `<레코드 값>:0`, `<레코드 값>:1`).

## 에이전트별 문서

Plugin을 구현할 때 에이전트마다 따로 문서를 만들고 다음을 적습니다.

- **Session ID와 Agent ID**: Main Agent와 Subagent 각각의 Session ID, Agent ID, 부모 Agent ID를 Session Log에서 알아내는 방법. [Session ID와 Agent ID](#session-id와-agent-id)의 규칙을 지키는 방법을 포함합니다.
- **Trigger**: [Trigger](#trigger)에서 Plugin이 정의하는 것
- **Session Log**: Log 수집 방식. [수집 방식](#수집-방식)에서 Plugin이 정의하는 것을 포함합니다.
- **변환**: 레코드를 Session Log Event로 옮기는 방법과, [Turn 단위](#turn-단위)의 기준을 알아보는 방법. 다음을 알아보는 방법을 포함합니다.
  - 응답이 끝난 이유를 [Domain Model](DOMAIN_MODEL.md#assistant_message)의 `stop_reason` 값으로 옮기는 방법
  - LLM 호출 오류와 재시도, 그리고 에이전트가 재시도를 그만두었는지
  - compaction과 그 `trigger`, 요약
  - 도구 실행이 띄운 Subagent의 Agent ID
- **Batch 단위**: [Batch 단위](#batch-단위)에서 Plugin이 정의하는 것
- **input 기록 범위**: LLM Call의 input([Glossary](GLOSSARY.md) 참고) 가운데 그 에이전트가 Session Log에 기록하는 것과 기록하지 않는 것. 기록하지 않는 input은 Plugin이 만들어 내지 않습니다.

## 결정되지 않은 사항

- 재시도를 모두 실패한 Batch를 나중에 다시 보내는 방법
- Subagent를 자신을 띄운 Tool Call과 잇는 방법([Domain Model](DOMAIN_MODEL.md#결정되지-않은-사항) 참고)
