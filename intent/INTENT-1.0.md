# INTENT-1.0.md

이 문서는 프로젝트가 무엇을 위해 존재하는지와 사용자가 이 도구로 얻어야 하는 결과를 설명합니다. 구현 방법은 다루지 않으며, 설계는 [docs/](../docs/)와 [adr/](../adr/)에 있습니다. 용어는 [Glossary](../docs/model/GLOSSARY.md)를 따릅니다.

## Problem

Claude Code, OpenCode, Codex 같은 AI 코딩 에이전트는 ReAct 방식으로 일합니다. LLM에 input을 넣어 reasoning하고, 그 결과로 action(Tool Call)을 취한 뒤, 결과를 다시 input으로 넣는 Agentic Loop를 반복합니다. 사용자는 이 과정을 거의 보지 못하고 최종 결과만 봅니다.

그래서 다음을 알기 어렵습니다.

- **실패의 원인**: 사람이 결과물을 검증하다가(휴먼 게이트) 실패라고 판단해도, 에이전트가 처음 상태에서 어떤 경로를 거쳐 지금 상태에 이르렀는지 되짚을 수 없습니다. 어느 Loop에서 어떤 input을 보고 잘못 판단했는지 찾을 수 없습니다.
- **토큰 낭비**: 토큰이 어디에 얼마나 쓰였는지, 어디서 낭비되었는지 알 수 없습니다.

병목 지점을 모르니 워크플로우와 하네스를 개선하는 일이 짐작에 의존하게 됩니다.

## Proposed Outcome

사용자는 에이전트의 작업이 끝난 뒤 Agentic Loop의 내부 과정을 되짚어 병목 지점을 찾고, 이를 근거로 워크플로우와 하네스를 개선할 수 있어야 합니다.

구체적으로 사용자는 다음을 할 수 있어야 합니다.

1. **역추적**: 실패라고 판단한 작업에서 출발해, 처음 상태부터 현재 상태까지 에이전트가 거친 과정을 Turn, Loop, LLM Call, Tool Call 단위로 되짚습니다.
2. **LLM Call 단위로 input과 output 확인**: 각 LLM Call에 무엇이 들어갔고 무엇이 나왔는지 봅니다.
   - input은 LLM에 들어간 **모든 것**입니다. 시스템 프롬프트, AGENTS.md(CLAUDE.md), Skill, 도구 정의, compaction 결과, Subagent에 넘긴 프롬프트, 사용자 메시지, 이전 모델 응답, 도구 결과가 모두 포함됩니다.
   - output은 reasoning과, 그 결과로 취한 action(Tool Call)입니다.
3. **잘못된 판단 지점 찾기**: 위 정보로 AI가 어느 지점에서 잘못 판단했는지 사람이 찾아냅니다.
4. **토큰 사용 파악**: 토큰이 어느 LLM Call, Loop, Turn에서 얼마나 쓰였는지 보고 낭비되는 지점을 찾습니다.

에이전트가 로그에 남기지 않아서 얻을 수 없는 정보는 지금 보여 주지 않으며, 추후 개선 과제로 남깁니다.

### 범위 밖

- 진행 중인 Turn을 실시간으로 관찰하는 기능. 사후 분석으로 충분합니다.
- 사용자가 중간에 멈춘 Turn. 수집하지 않고 버립니다.
- 실패 여부의 자동 판정과 원인의 자동 분석. 실패는 사람이 판단합니다.
- 달러 단위 비용 계산
- 에이전트 사이의 성능 비교
- 알림

## Affected Users and Systems

### 사용자

AI 코딩 에이전트에게 작업을 맡기고 그 결과를 검증하는 개발자입니다. 사용 범위는 다음 순서로 넓힙니다.

1. 프로젝트 작성자 본인
2. 작성자가 속한 팀의 구성원
3. 오픈소스로 공개해 불특정 개발자

### 관찰 대상 에이전트

| 에이전트 | 지원 계획 |
|---|---|
| Claude Code | 우선 지원 |
| OpenCode | 우선 지원 |
| Codex | 지원 예정 |

### 관련 시스템

- 에이전트가 실행되는 머신의 에이전트 프로세스와 Session Log File
- 이 프로젝트의 Client Adapter Daemon과 Main Server([System Architecture](../docs/model/SYSTEM_ARCHITECTURE.md) 참고)

## Constraints

### 확정된 사항

- 분석은 사후에 합니다. 데이터는 Turn이 끝난 뒤에 볼 수 있으면 됩니다.
- 사용자가 중간에 멈춘 Turn은 버립니다.
- 에이전트가 기록하지 않는 정보는 만들어 내지 않습니다.
- 실패 판단은 사람이 합니다. 이 도구는 판단에 필요한 정보를 제공할 뿐입니다.

### 현재 설계의 원칙

다음은 [System Architecture](../docs/model/SYSTEM_ARCHITECTURE.md#principles)에 정한 원칙입니다. 팀과 오픈소스 단계에서도 유지할지는 아직 정하지 않았습니다([Open Questions](#open-questions) 참고).

- **Observe-only**: 에이전트를 관찰만 합니다. 동작을 막거나 바꾸지 않고, 컨텍스트에 아무것도 주입하지 않습니다.
- **Fail-open**: 이 도구 때문에 에이전트의 작업이 멈추면 안 됩니다. 이벤트 유실을 허용합니다.
- **마스킹 없음**: 프롬프트와 도구 결과의 원문을 그대로 수집하고 전송합니다.

## Open Questions

1. **확장 단계의 원칙**: 팀과 오픈소스 단계에서도 Observe-only, Fail-open, 마스킹 없음을 유지할지 정하지 않았습니다. 특히 팀 서버로 프롬프트, 코드, 도구 결과의 원문을 보낼 때 무엇을 보호해야 하는지가 열려 있습니다.
2. **원격 전송의 인증과 암호화**: 팀에 공유하려면 필요하지만 아직 정하지 않았습니다.
3. **나머지 input의 전송 형식**: [Agent Logging Protocol](../docs/model/AGENT_LOGGING_PROTOCOL.md) 버전 1은 LLM Call의 모든 input을 다룹니다. 그 가운데 시스템 프롬프트, AGENTS.md, Skill, 도구 정의, compaction, Subagent 프롬프트를 나타내는 형식은 아직 정하지 않았습니다.
4. **에이전트별로 얻을 수 있는 정보**: Claude Code, OpenCode, Codex가 각각 3번의 input 중 무엇을 로그에 남기는지 확인하지 않았습니다.
5. **Subagent와 부모의 연결**: Subagent에 넘긴 프롬프트와 그 Subagent의 Loop를 부모 Tool Call과 어떻게 이을지 정하지 않았습니다.
6. **"토큰 낭비"의 기준**: 어떤 토큰 사용을 낭비로 볼지 정하지 않았습니다.
7. **역추적에 필요한 화면**: 잘못된 판단 지점과 토큰 낭비를 찾으려면 무엇을 함께 보여 줘야 하는지 정하지 않았습니다.
8. **지원 순서**: Claude Code와 OpenCode 사이의 순서, Codex를 지원하기 시작할 시점을 정하지 않았습니다.
