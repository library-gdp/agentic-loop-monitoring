---
status: accepted
date: 2026-10-24
decision-makers: pgd
---

# Merge Wire Event and Canonical Event into Session Log Event

## Context and Problem Statement

[Split the system into a Client Adapter Daemon and a Main Server](2026-10-19-split-system-into-client-adapter-daemon-and-main-server.md)는 이벤트 모델을 둘로 나눴습니다. Plugin이 만들어 Main Server로 보내는 전송 형식인 Wire Event와, Main Server의 Core가 정의하는 Canonical Event입니다. Main Server의 Input Adapter가 Decoder로 Wire Event를 Canonical Event로 변환했습니다.

두 모델은 모두 에이전트 종류와 무관한 공통 이벤트를 나타내며, 같은 것입니다. 같은 것을 두 이름과 두 모델로 나누면 용어가 늘고 그 사이를 변환하는 코드가 생깁니다.

## Decision

Wire Event와 Canonical Event를 **Session Log Event** 하나로 합칩니다.

- Session Log Event의 구조는 Wire Event의 구조를 그대로 따릅니다. 구조는 [Domain Model](../docs/model/002.DOMAIN_MODEL.md#session-log-event)이 정의합니다.
- Client Adapter Daemon과 Main Server의 Core가 같은 Session Log Event 모델을 씁니다. Input Adapter는 Session Log Event를 다른 모델로 변환하지 않고 Core에 넘깁니다. Decoder는 Session Log Event를 deserialization합니다.
- 이름을 함께 바꿉니다. Wire Protocol은 Agent Logging Protocol이 되며, 문서는 `docs/AGENT_LOGGING_PROTOCOL.md`로 옮깁니다.

## Consequences

- Good, because 같은 것을 가리키는 용어가 하나로 줄어듭니다.
- Good, because Input Adapter에서 이벤트 모델을 변환하는 코드가 없어집니다.
- Bad, because Session Log Event의 구조를 바꾸면 Core도 함께 바뀝니다. 전송 형식과 Core의 모델을 따로 바꿀 수 없습니다.

## Implementation Plan

- **Affected paths**: 아직 코드가 없습니다. 설계 문서는 다음과 같습니다.
  - [`docs/model/003.AGENT_LOGGING_PROTOCOL.md`](../docs/model/003.AGENT_LOGGING_PROTOCOL.md): `docs/WIRE_PROTOCOL.md`에서 이름을 바꿈
  - [`docs/model/001.GLOSSARY.md`](../docs/model/001.GLOSSARY.md): Wire Protocol, Wire Event, Canonical Event를 Agent Logging Protocol, Session Log Event로 바꿈
  - [`docs/model/006.APPLICATION_ARCHITECTURE.md`](../docs/model/006.APPLICATION_ARCHITECTURE.md), [`docs/model/000.SYSTEM_ARCHITECTURE.md`](../docs/model/000.SYSTEM_ARCHITECTURE.md): Input Adapter의 변환 제거
- **Dependencies**: 없음
- **Patterns to avoid**:
  - Main Server에 Session Log Event와 별도인 공통 이벤트 모델을 두지 않습니다.

### Verification

- [ ] Main Server 소스에 Session Log Event를 다른 이벤트 모델로 바꾸는 코드가 없습니다.

## Alternatives Considered

- **Wire Event와 Canonical Event를 따로 유지**: 이전 설계입니다. 두 모델이 같은 것을 나타내므로 용어와 변환 코드만 늘어나 기각했습니다.

## More Information

- 대체하는 부분: [Split the system into a Client Adapter Daemon and a Main Server](2026-10-19-split-system-into-client-adapter-daemon-and-main-server.md)의 "Wire Event와 Canonical Event는 서로 다른 모델" 결정
- 용어: [Glossary](../docs/model/001.GLOSSARY.md)
