# CLAUDE_CODE.md

이 문서는 Claude Code Plugin의 구현 방안을 정합니다. [Plugin Specification](../../model/PLUGIN_SPEC.md#에이전트별-문서)이 정한 에이전트별 문서이며, Plugin의 역할과 규칙은 model 문서를 따릅니다. Plugin 공통 구현 방안은 [Plugin Guide](../PLUGIN_GUIDE.md)를, 용어는 [Glossary](../../model/GLOSSARY.md)를 따릅니다.

에이전트 id는 `claude-code`입니다.

## Session ID와 Agent ID

| Agent | Session ID | Agent ID | 부모 Agent ID |
|---|---|---|---|
| Main Agent | 레코드의 `sessionId` | Session ID | 비움(NULL) |
| Subagent | 레코드의 `sessionId`. Main Agent와 같은 값입니다. | 레코드의 `agentId`. Claude Code가 Subagent를 띄울 때 만든 값입니다. | 자신을 띄운 Agent의 Agent ID |

아래 내용은 Claude Code 2.1.263이 기록한 Session Log에서 확인했습니다.

### Session Log의 위치

Claude Code는 Main Agent와 Subagent의 Session Log를 각각 다른 JSONL 파일에 기록합니다. `~/.claude`는 `CLAUDE_CONFIG_DIR` 환경 변수로 바뀔 수 있습니다.

| Agent | 파일 |
|---|---|
| Main Agent | `~/.claude/projects/<작업 디렉터리>/<Session ID>.jsonl` |
| Subagent | `~/.claude/projects/<작업 디렉터리>/<Session ID>/subagents/agent-<agentId>.jsonl` |
| Subagent 메타데이터 | `~/.claude/projects/<작업 디렉터리>/<Session ID>/subagents/agent-<agentId>.meta.json` |

`<작업 디렉터리>`는 작업 디렉터리 경로의 `/`, `.` 같은 문자를 `-`로 바꾼 이름입니다(예: `/home/user/my-project` → `-home-user-my-project`).

### Session ID

Main Agent와 Subagent의 모든 레코드에 `sessionId` 필드가 있습니다. Subagent의 레코드도 Main Agent와 같은 `sessionId`를 기록하므로, Plugin은 이 값을 그대로 Session ID로 씁니다. Subagent 파일이 `<Session ID>/subagents/` 아래에 있으므로 경로로도 알 수 있습니다.

### Agent ID

- **Main Agent**: Session ID를 Agent ID로 씁니다. Main Agent의 레코드에는 `agentId` 필드가 없습니다.
- **Subagent**: 레코드의 `agentId`를 Agent ID로 씁니다. 파일 이름 `agent-<agentId>.jsonl`의 값과 같습니다. Subagent의 레코드는 `isSidechain`이 `true`입니다.

### 부모 Agent ID

Subagent 메타데이터 파일에 다음 필드가 있습니다.

| 필드 | 설명 |
|---|---|
| `toolUseId` | 이 Subagent를 띄운 `tool_use` 블록의 id입니다. |
| `spawnDepth` | 이 Subagent가 Main Agent로부터 몇 단계 아래에 있는지입니다. Main Agent가 바로 띄웠으면 `1`입니다. |
| `agentType` | Subagent의 종류입니다(예: `general-purpose`). |

Plugin은 다음과 같이 부모 Agent ID를 정합니다.

- `spawnDepth`가 `1`이면 부모 Agent는 Main Agent이므로 Session ID를 부모 Agent ID로 씁니다.
- 그렇지 않으면 같은 Session의 Subagent 파일 가운데 id가 `toolUseId`인 `tool_use` 블록을 기록한 Subagent를 찾고, 그 Subagent의 Agent ID를 부모 Agent ID로 씁니다.

부모 Agent의 Session Log에서 그 `tool_use` 블록의 결과 레코드는 `toolUseResult.agentId`에 띄운 Subagent의 Agent ID를 기록합니다. 부모 쪽에서 Subagent를 찾을 때는 이 값을 씁니다.

## 결정되지 않은 사항

- [Plugin Specification](../../model/PLUGIN_SPEC.md#에이전트별-문서)이 정한 나머지 항목: Trigger, Session Log 수집 방식, 변환, input 기록 범위
- `--resume`, `--fork-session`처럼 이전 대화를 이어 가거나 갈라낸 경우의 Session ID
- 메타데이터 파일이 아직 기록되지 않았거나 `toolUseId`에 해당하는 `tool_use` 블록을 찾지 못해 부모 Agent ID를 정할 수 없을 때의 처리
