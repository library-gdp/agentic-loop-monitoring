# PLUGIN_GUIDE.md

이 문서는 [Plugin Specification](../model/PLUGIN_SPEC.md)을 따르는 Plugin을 구현하는 방안을 정합니다. Plugin의 역할과 규칙은 model 문서를 따르며, 이 문서는 바꾸지 않습니다. 구현 언어는 [Tech Stack](TECH_STACK.md)을, 용어는 [Glossary](../model/GLOSSARY.md)를 따릅니다.

## Plugin을 Daemon에 넣는 방식

Plugin 코드는 Daemon 실행 파일에 함께 빌드합니다. Daemon은 실행 중에 Plugin을 불러오지 않으며, Daemon 설정의 "사용할 Plugin"은 실행 파일에 들어 있는 Plugin 가운데 활성화할 것을 고릅니다. 새 에이전트를 지원하거나 Plugin을 고치면 Daemon을 다시 빌드하고 배포합니다. 결정 배경은 [Bundle Plugins into the Client Adapter Daemon executable](../../adr/2026-10-22-bundle-plugins-into-daemon-executable.md)을 참고하세요.

Plugin은 에이전트마다 패키지 하나로 만들고, Daemon은 이 패키지를 라이브러리로 가져다 씁니다. 결정 배경은 [Add Plugins to the Daemon as library packages](../../adr/2026-10-28-add-plugins-to-daemon-as-library-packages.md)를 참고하세요.

### 패키지 구성

| 패키지 | 내용 | 의존하는 패키지 |
|---|---|---|
| Plugin API | [Plugin Interface](PLUGIN_INTERFACE.md)의 타입 | 없음 |
| Plugin | 에이전트 하나의 Plugin 구현. 에이전트마다 하나씩 둡니다. | Plugin API(`peerDependencies`) |
| Daemon | Plugin 등록 목록, Batch 전송, Transport Client | Plugin API, 각 Plugin(`dependencies`) |

- Plugin 패키지는 Plugin API를 `peerDependencies`로, Daemon은 `dependencies`로 선언합니다. Daemon 빌드에는 Plugin API가 하나만 들어가며, 모든 Plugin이 같은 버전의 타입으로 타입 검사를 통과해야 빌드됩니다.
- Plugin 패키지는 Daemon 패키지나 다른 Plugin 패키지에 의존하지 않습니다. Daemon에 접근하는 방법은 `start`에 넘겨받는 `PluginContext`뿐입니다.
- Plugin API는 타입만 담습니다.

### Plugin 패키지가 지킬 것

- **`Plugin` 객체 하나를 내보냅니다.** 패키지의 진입점에서 [`Plugin`](PLUGIN_INTERFACE.md#plugin)을 구현한 객체를 `plugin`이라는 이름으로 내보냅니다(named export).
- **`version`은 패키지 버전과 같습니다.** Plugin을 고치면 패키지 버전을 올리고, `plugin.version`도 같은 값으로 바꿉니다.
- **불러오기만으로는 아무 일도 하지 않습니다.** Daemon은 활성화 여부와 관계없이 모든 Plugin 패키지를 정적으로 불러옵니다. 그래서 패키지를 불러올 때 파일을 읽거나, 감시를 시작하거나, 타이머를 거는 등의 부수 효과를 두지 않습니다. 이런 일은 `start`에서 시작합니다.

```ts
// Plugin 패키지의 진입점
import type { Plugin, PluginContext } from "plugin-api";

export const plugin: Plugin = {
  agent: "claude-code",
  version: "0.1.0",
  async start(context: PluginContext) {
    // Trigger를 설정합니다. 수집한 Batch는 context.submit으로 넘깁니다.
  },
  async stop() {
    // Trigger를 해제하고 진행 중인 수집을 멈춥니다.
  },
};
```

### Daemon에 Plugin 추가하기

1. 에이전트의 Plugin 패키지를 만듭니다. 위의 [Plugin 패키지가 지킬 것](#plugin-패키지가-지킬-것)을 따릅니다.
2. Daemon 패키지의 `dependencies`에 Plugin 패키지를 추가합니다.
3. Daemon의 등록 목록에 Plugin을 정적 `import`로 추가합니다. 등록 목록은 Daemon에 하나만 둡니다. 동적 `import()`나 경로를 문자열로 조립한 `require`로 불러오지 않습니다.

   ```ts
   // Daemon의 등록 목록
   import type { Plugin } from "plugin-api";
   import { plugin as claudeCode } from "plugin-claude-code";
   import { plugin as codex } from "plugin-codex";
   import { plugin as opencode } from "plugin-opencode";

   export const plugins: readonly Plugin[] = [claudeCode, codex, opencode];
   ```

4. [에이전트별 문서](#에이전트별-문서)를 추가합니다.
5. Daemon을 다시 빌드하고 배포합니다.

등록 목록의 Plugin은 `agent`가 서로 달라야 합니다. Daemon은 시작할 때 설정의 "사용할 Plugin"에 있는 에이전트 id로 등록 목록에서 Plugin을 찾아 `start`를 부릅니다([Plugin Interface](PLUGIN_INTERFACE.md#시작과-종료) 참고).

위 예시의 패키지 이름은 예시입니다.

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

- Plugin이 수집한 위치 같은 자신의 상태를 저장하는 위치
- 패키지 이름과 저장소 구성. Plugin 패키지를 Daemon과 같은 저장소의 workspace로 둘지, 따로 배포하는 패키지로 둘지
- 패키지 관리 도구
- 설정의 "사용할 Plugin"에 등록 목록에 없는 에이전트 id가 있을 때의 처리
