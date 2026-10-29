---
status: proposed
date: 2026-10-28
decision-makers: pgd
---

# Keep Session Log Events as the source data and derive the activity model

## Context and Problem Statement

[Domain Model](../docs/model/DOMAIN_MODEL.md)은 Main Server가 Session Log Event를 받은 그대로 저장하고, Core가 그 순서와 연결 관계로 Session, Agent, Turn, Loop, LLM Call, Tool Call(활동 모델)을 구성한다고 정합니다. 하지만 무엇을 저장하고 무엇을 계산하는지, 활동 모델을 언제 구성하는지는 정하지 않았습니다. Persistence를 구현하려면 이것을 정해야 합니다.

데이터에는 다음 성질이 있습니다.

- Session Log는 에이전트가 소유하므로 지워질 수 있고, Daemon은 Ack를 받은 Transport Unit을 보관하지 않습니다. Ack 뒤에는 Main Server가 유일한 사본을 가집니다.
- Main Server는 아직 모르는 Session Log Event 종류와 필드를 무시합니다([알 수 없는 값](../docs/model/AGENT_LOGGING_PROTOCOL.md#알-수-없는-값)). 시스템 프롬프트, 도구 정의 같은 나머지 input의 형식도 앞으로 추가됩니다.
- 활동 모델의 구성 규칙에는 아직 정하지 않은 것이 많습니다(Agent 안 Turn의 순서, LLM Call input의 범위 등).
- LLM Call의 input은 같은 Agent의 앞선 Session Log Event 전부입니다. LLM Call마다 복사하면 데이터가 제곱으로 늘어납니다.
- Session Log Event의 소속 Turn과 Turn 안 위치는 Session Log Event가 아니라 Transport Unit의 `turn`에 실려 옵니다([Agent Logging Protocol](../docs/model/AGENT_LOGGING_PROTOCOL.md#transport-unit)).

## Decision

Main Server의 데이터를 원본 데이터와 파생 데이터로 나눕니다. 자세한 내용은 [Data Architecture](../docs/model/DATA_ARCHITECTURE.md)가 정합니다.

- **원본 데이터**: Session, Agent, Session Log Event, 수신 기록입니다. 추가만 하고 고치지 않습니다. Session Log Event는 모르는 종류와 필드까지 원문 그대로 저장하고, Transport Unit에서만 알 수 있는 소속 Turn, Turn 안 위치, Turn의 끝인지를 함께 저장합니다. 수신 기록은 Transport Unit의 `protocol_version`, `source.plugin_version`을 남깁니다.
- **파생 데이터**: Turn, LLM Call, Tool Call의 색인입니다. 원본 데이터로 언제든 다시 만들 수 있으며, 큰 내용은 담지 않고 원본 데이터를 가리킵니다. 구성 규칙의 버전을 가지며, 규칙이 바뀌면 모두 다시 만듭니다.
- **LLM Call의 input**은 저장하지 않고 질의할 때 원본 데이터에서 범위로 읽습니다.
- Transport Unit 하나의 원본 데이터 추가와, 그 Transport Unit이 속한 Turn의 파생 데이터 재구성을 **한 번에 원자적으로** 처리한 뒤 `accepted`를 돌려줍니다.
- 데이터는 **Session 단위로만** 지웁니다.

**범위 밖**

- 저장소 기술과 물리 스키마. [Store Main Server data in SQLite](2026-10-28-store-main-server-data-in-sqlite.md)에서 정합니다.
- Agent 안 Turn의 순서 기준, LLM Call input의 시작 범위. [Domain Model](../docs/model/DOMAIN_MODEL.md#결정되지-않은-사항)에서 정합니다.
- 보관 기간, 암호화, 접근 제어

## Consequences

- Good, because 원문을 남기므로, Main Server가 새 Session Log Event 종류나 필드를 이해하게 되면 다시 수집하지 않고 지난 데이터에도 적용할 수 있습니다.
- Good, because 활동 모델의 구성 규칙이 정해지거나 바뀌어도 파생 데이터만 다시 만들면 됩니다. 원본 데이터를 마이그레이션하지 않습니다.
- Good, because 파생 데이터가 색인 역할을 하므로, Turn 목록이나 Token Usage 합계를 볼 때 큰 원문을 해석하지 않습니다.
- Good, because 파생 데이터를 Turn 하나의 Session Log Event만으로 만들므로, 비용이 그 Turn의 크기에만 비례하고 `accepted` 직후 조회할 수 있습니다.
- Bad, because 일부 값(`type`, `timestamp`, Token Usage 등)이 원문과 파생 데이터에 두 번 있습니다. 파생 데이터는 원본 데이터와 어긋나면 다시 만들어야 합니다.
- Bad, because LLM Call의 input을 볼 때마다 앞선 Session Log Event를 읽어야 합니다. Agent가 길면 이 질의가 무거워집니다.
- Bad, because Session 일부만 지울 수 없습니다.

## Implementation Plan

- **Affected paths**: 아직 코드가 없습니다. 설계 문서는 다음과 같습니다.
  - [`docs/model/DATA_ARCHITECTURE.md`](../docs/model/DATA_ARCHITECTURE.md): 새 문서
  - [`docs/model/AGENT_LOGGING_PROTOCOL.md`](../docs/model/AGENT_LOGGING_PROTOCOL.md): "무시"가 저장하지 않는다는 뜻이 아님을 밝힘
  - [`docs/model/GLOSSARY.md`](../docs/model/GLOSSARY.md): 원본 데이터, 파생 데이터, 수신 기록 추가
  - [`docs/model/APPLICATION_ARCHITECTURE.md`](../docs/model/APPLICATION_ARCHITECTURE.md), [`docs/model/SYSTEM_ARCHITECTURE.md`](../docs/model/SYSTEM_ARCHITECTURE.md): Data Architecture 링크
- **Dependencies**: 없음
- **Patterns to follow**:
  - 파생 데이터는 원본 데이터만 읽어 만드는 함수 하나로 만듭니다. 쓰기와 재구성이 같은 함수를 씁니다.
  - Turn의 파생 데이터는 그 Turn의 Session Log Event만 읽어 만듭니다.
- **Patterns to avoid**:
  - 저장한 Session Log Event의 원문을 고치지 않습니다.
  - 파생 데이터에만 있고 원본 데이터로 다시 만들 수 없는 값을 두지 않습니다.
  - LLM Call의 input을 LLM Call마다 복사해 저장하지 않습니다.

### Verification

- [ ] 파생 데이터를 모두 지우고 다시 만든 결과가 지우기 전과 같습니다.
- [ ] 같은 Transport Unit을 두 번 받아도 원본 데이터와 파생 데이터가 한 번 받은 것과 같습니다.
- [ ] 모르는 `type`의 Session Log Event를 담은 Transport Unit을 받으면, 그 Session Log Event가 원문 그대로 저장되고 활동 모델에는 나타나지 않습니다.
- [ ] 파생 데이터를 만들다 실패한 Transport Unit은 원본 데이터도 남기지 않고 `unavailable`로 거절됩니다.

## Alternatives Considered

- **활동 모델만 저장**: Transport Unit을 받을 때 활동 모델로 바꿔 저장하고 Session Log Event는 버립니다. 저장 구조가 단순하지만, 모르는 값을 잃고 구성 규칙이 바뀌면 지난 데이터를 다시 만들 수 없습니다. Session Log가 지워졌으면 되살릴 방법이 없어 기각했습니다.
- **Session Log Event만 저장하고 활동 모델은 매번 계산**: 저장 데이터가 가장 적고 어긋날 것이 없습니다. 하지만 Session 목록, Turn 목록, Token Usage 합계를 볼 때마다 큰 원문을 모두 해석해야 합니다. 나중에 필요하면 파생 데이터를 더하는 것과 같으므로, 처음부터 색인을 두기로 했습니다.
- **파생 데이터를 비동기로 구성**: `accepted`가 빨라지지만, 받은 Transport Unit이 한동안 보이지 않고 구성 실패를 따로 다시 시도해야 합니다. 분석은 사후에 하므로 빠른 Ack가 필요하지 않아 기각했습니다.
- **LLM Call input을 LLM Call마다 저장**: 질의는 빠르지만 저장량이 제곱으로 늘고, input 범위의 규칙이 바뀌면 모두 다시 써야 해 기각했습니다.

## More Information

- 관련 결정: [Merge Wire Event and Canonical Event into Session Log Event](2026-10-24-merge-wire-event-and-canonical-event-into-session-log-event.md), [Send Session Log Events one record per Transport Unit](2026-10-29-send-session-log-events-one-record-per-transport-unit.md)
- 다시 볼 조건: 시스템 프롬프트, 도구 정의처럼 LLM Call마다 되풀이되는 input의 형식이 정해질 때. 같은 내용을 한 번만 저장하는 방법이 필요해집니다.
