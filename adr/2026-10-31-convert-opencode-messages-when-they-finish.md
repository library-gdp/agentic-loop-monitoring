---
status: proposed
date: 2026-10-31
decision-makers: pgd
---

# Convert OpenCode messages when they finish

## Context and Problem Statement

OpenCode 1.19.x는 LLM Call 하나를 `event` 행 여러 개에 part별로 나누어 기록하고, 도구 결과도 같은 message의 part로 기록합니다. [Plugin Specification](../docs/001.model/005.PLUGIN_SPEC.md#transport-unit)은 레코드 하나마다 Transport Unit 하나를 넘기라고 하고, `assistant_message`는 LLM Call 하나의 내용을 한 번에 담아야 합니다. `event` 행을 레코드로 그대로 쓰면 LLM Call 하나가 `assistant_message` 여러 개로 나뉩니다.

또한 OpenCode는 사용자 메시지 형태의 지시문, 사용자 shell, subtask처럼 프롬프트도 LLM Call도 아니지만 뒤 LLM Call의 input에 들어가는 내용을 기록합니다. 기존 Session Log Event 종류로는 이것을 나타낼 수 없었습니다.

## Decision Drivers

- `assistant_message` 하나가 LLM Call 하나여야 합니다.
- input은 LLM에 들어간 **모든 것**이어야 합니다([Intent](../intent/INTENT-1.0.md#proposed-outcome)).
- 에이전트가 기록하지 않은 값을 만들지 않습니다.
- 사후 분석으로 충분합니다. Turn 진행 중의 지연은 허용합니다.

## Decision

- OpenCode Plugin의 레코드를 message 하나로 봅니다. message를 끝내는 `event` 행에서 Session Log Event를 만들고, `assistant_message`와 `tool_result`를 Transport Unit 하나에 담습니다.
- 끝나지 않은 message의 part만 메모리에 두고, 저장하는 수집 위치는 그 message 앞에 둡니다. 다시 시작하면 그 위치부터 읽어 같은 결과를 만듭니다.
- Session Log Event 종류 `context_message`를 더합니다. `protocol_version`은 올리지 않습니다.
- 사용자 shell과 subtask는 LLM Call이 없으므로 Tool Call이 아니라 `context_message`로 나타냅니다.
- Agent 안의 Turn 순서는 `started_at`, 같으면 먼저 받은 순서로 정합니다.
- HTML과 SPA 번들도 Hono 라우트로 내줍니다. `Bun.serve`의 `routes`는 접근 토큰 검사를 거치지 않습니다.

자세한 규칙은 [OpenCode Plugin](../docs/002.implementation/006.plugin/003.OPENCODE.md#변환)을 따릅니다.

## Consequences

- Good, because LLM Call, Tool Call, input이 추가 규칙 없이 Core의 기존 구성 규칙으로 만들어집니다.
- Good, because Core는 `context_message`를 다른 Session Log Event처럼 저장하고 input에 포함할 뿐, 새 구성 규칙이 필요하지 않습니다.
- Bad, because 오래 실행되는 tool과 Subagent는 message가 끝날 때까지 부모 Agent에 나타나지 않습니다.
- Bad, because OpenCode가 강제 종료되면 끝나지 않은 message의 text와 reasoning을 잃습니다. DB에 내용이 없기 때문입니다.
- Neutral, because 사용자 shell은 다음 프롬프트까지 넘어가지 않습니다.

## Alternatives Considered

- **`event` 행마다 Session Log Event 만들기**: 곧바로 보이지만 LLM Call 하나가 나뉘고, usage가 도구 실행 뒤에야 기록되므로 앞의 Session Log Event를 고쳐야 합니다. 원본 데이터는 고치지 않습니다.
- **`message`, `part` 테이블 읽기**: 행을 제자리에서 갱신하므로 수집 위치를 정할 수 없습니다.
- **`context_message` 없이 `user_message`를 Turn 중간에 쓰기**: `user_message`가 Turn을 시작한다는 규칙과 어긋납니다.
- **`context_message`로 나타낼 내용을 버리기**: 뒤 LLM Call의 input이 실제와 달라집니다.
- **사용자 shell을 혼자 Turn으로 만들기**: 응답이 없어 다음 Turn이 시작될 때 `errored`로 보입니다. 실패를 찾는 도구에서 거짓 신호가 됩니다.

## More Information

- 실제 OpenCode 1.19.5 DB에는 정상 종료한 Turn만 있어서, 나머지 경로는 v1.19.5 소스에서 읽은 기록 순서로 만든 테스트로 확인했습니다.
- 관련 ADR: [Send Session Log Events one record per Transport Unit](2026-10-29-send-session-log-events-one-record-per-transport-unit.md), [Choose the implementation tooling and Visualization stack](2026-10-30-choose-the-implementation-tooling-and-visualization-stack.md)
