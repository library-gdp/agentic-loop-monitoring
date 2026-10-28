# PLUGIN_GUIDE.md

이 문서는 [Plugin Specification](../model/PLUGIN_SPEC.md)을 따르는 Plugin을 구현하는 방안을 정합니다. Plugin의 역할과 규칙은 model 문서를 따르며, 이 문서는 바꾸지 않습니다. 구현 언어는 [Tech Stack](TECH_STACK.md)을, 용어는 [Glossary](../model/GLOSSARY.md)를 따릅니다.

## Plugin을 Daemon에 넣는 방식

Plugin 코드는 Daemon 실행 파일에 함께 빌드합니다. Daemon은 실행 중에 Plugin을 불러오지 않으며, Daemon 설정의 "사용할 Plugin"은 실행 파일에 들어 있는 Plugin 가운데 활성화할 것을 고릅니다. 새 에이전트를 지원하거나 Plugin을 고치면 Daemon을 다시 빌드하고 배포합니다. 결정 배경은 [Bundle Plugins into the Client Adapter Daemon executable](../../adr/2026-10-22-bundle-plugins-into-daemon-executable.md)을 참고하세요.

## 에이전트별 문서

[Plugin Specification](../model/PLUGIN_SPEC.md#에이전트별-문서)이 정한 에이전트별 문서는 [`plugin/`](plugin/)에 둡니다.

| 에이전트 | 문서 |
|---|---|
| Claude Code | [Claude Code Plugin](plugin/CLAUDE_CODE.md) |
| Codex | [Codex Plugin](plugin/CODEX.md) |
| OpenCode | [OpenCode Plugin](plugin/OPENCODE.md) |

## Session Log를 파일로 수집하는 경우

에이전트가 Session Log를 파일로 기록하고 Plugin이 그 파일을 읽어 수집할 때는 다음을 따릅니다. 이 내용은 [Plugin Specification](../model/PLUGIN_SPEC.md)의 규칙을 파일에 적용한 것입니다.

- **Trigger**: 파일 변경 감시를 Trigger로 쓸 수 있습니다.
- **수집 방식**: 에이전트별 문서에 파일의 위치와, 그 파일이 어느 Session의 것인지 알아내는 방법을 적습니다. 파일이 다른 파일로 교체되거나, 잘리거나, 삭제되었을 때의 처리도 정합니다. 에이전트가 계속 쓰는 동안 파일 끝을 끝없이 따라가지 않도록 한 번에 읽는 범위를 정합니다.
- **완결되지 않은 레코드**: 레코드가 아직 다 기록되지 않았는지는 형식에 맞춰 판단합니다. 예를 들어 줄 단위 형식에서 마지막 줄이 줄바꿈으로 끝나지 않으면 그 레코드는 아직 기록 중입니다.
- **event id**: 에이전트가 레코드마다 고유 id를 기록하지 않으면, 파일 안에서 레코드의 위치로 event id를 만듭니다.

## 결정되지 않은 사항

- Plugin이 Session Log Event를 Daemon에 넘기는 TypeScript 인터페이스
- Plugin이 수집한 위치 같은 자신의 상태를 저장하는 위치
