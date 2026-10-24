# OPENCODE.md

이 문서는 OpenCode Plugin의 구현 방안을 정합니다. [Plugin Specification](../../model/PLUGIN_SPEC.md#에이전트별-문서)이 정한 에이전트별 문서이며, Plugin의 역할과 규칙은 model 문서를 따릅니다. Plugin 공통 구현 방안은 [Plugin Guide](../PLUGIN_GUIDE.md)를, 용어는 [Glossary](../../model/GLOSSARY.md)를 따릅니다.

에이전트 id는 `opencode`입니다.

## Session ID와 Agent ID

OpenCode는 Subagent를 띄울 때 Subagent만의 session(child session)을 새로 만듭니다. child session은 자신을 띄운 session의 id를 `parentID`로 기록합니다. 그래서 OpenCode에서는 Agent마다 session id가 다르며, Main Agent의 session id만 Session ID가 됩니다.

| Agent | Session ID | Agent ID | 부모 Agent ID |
|---|---|---|---|
| Main Agent | Main Agent의 session id | Session ID | 비움(NULL) |
| Subagent | Main Agent의 session id | Subagent의 session id | 자신을 띄운 Agent의 session id(`parentID`) |

### Session ID

`parentID`가 없는 session이 Main Agent의 session이며, 그 session id가 Session ID입니다. Subagent의 session에서는 `parentID`를 따라 `parentID`가 없는 session까지 올라가 Session ID를 찾습니다. Subagent의 session id는 Session ID가 아니므로 Batch의 `session.id`에 넣지 않습니다([Plugin Specification](../../model/PLUGIN_SPEC.md#session-id와-agent-id) 참고).

### Agent ID

각 Agent의 session id를 Agent ID로 씁니다. Main Agent는 Agent ID와 Session ID가 같습니다.

### 부모 Agent ID

- **Main Agent**: `parentID`가 없으므로 비웁니다.
- **Subagent**: session의 `parentID`를 부모 Agent ID로 씁니다. Subagent가 띄운 Subagent라면 `parentID`는 부모 Subagent의 session id입니다.

## 결정되지 않은 사항

- [Plugin Specification](../../model/PLUGIN_SPEC.md#에이전트별-문서)이 정한 나머지 항목: Trigger, Session Log 수집 방식, 변환, input 기록 범위
- OpenCode가 session과 메시지를 저장하는 위치와 형식. OpenCode 버전에 따라 다를 수 있으므로 지원할 버전에서 확인한 뒤 적습니다. 위의 `parentID` 관계도 그 버전에서 확인합니다.
- 부모 session을 아직 찾을 수 없어 Session ID를 정하지 못할 때의 처리
