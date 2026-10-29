# PLUGIN_GUIDE.md

이 문서는 [Plugin Specification](../model/PLUGIN_SPEC.md)을 따르는 Plugin을 구현하는 방안을 정합니다. Plugin의 역할과 규칙은 model 문서를 따르며, 이 문서는 바꾸지 않습니다. 구현 언어는 [Tech Stack](TECH_STACK.md)을, 용어는 [Glossary](../model/GLOSSARY.md)를 따릅니다.

## Plugin을 Daemon에 넣는 방식

Daemon은 어떤 Plugin이 있는지 모릅니다. Daemon 소스와 실행 파일에는 Plugin 코드도, Plugin 목록도 없습니다. Plugin은 Daemon과 따로 빌드하며, 빌드한 Plugin을 Plugin 디렉터리에 넣으면 Daemon이 실행 중에 불러옵니다. 새 에이전트를 지원하거나 Plugin을 고칠 때 Daemon을 다시 빌드하지 않습니다. 결정 배경은 [Load built Plugins into the Daemon at runtime](../../adr/2026-10-29-load-built-plugins-into-daemon-at-runtime.md)을 참고하세요.

### 패키지 구성

| 패키지 | 내용 | 의존하는 패키지 |
|---|---|---|
| Plugin API | [Plugin Interface](PLUGIN_INTERFACE.md)의 타입과 `PLUGIN_API_VERSION` | 없음 |
| Plugin | 에이전트 하나의 Plugin 구현. 에이전트마다 하나씩 둡니다. | Plugin API |
| Daemon | Plugin 로드, Batch 전송, Transport Client | Plugin API |

- Daemon과 Plugin은 Plugin API에만 의존합니다. Daemon은 Plugin 패키지에, Plugin은 Daemon 패키지나 다른 Plugin 패키지에 의존하지 않습니다.
- Plugin API에서 실행 중에 쓰는 값은 `PLUGIN_API_VERSION` 하나뿐이며, Plugin을 빌드할 때 Plugin 안에 함께 들어갑니다. 그래서 Daemon은 Plugin에 모듈을 제공하지 않습니다.

### 빌드한 Plugin

빌드한 Plugin은 디렉터리 하나입니다. 디렉터리 이름은 에이전트 id이며, 다음 두 파일을 둡니다.

```
<Plugin 디렉터리>/
└── claude-code/
    ├── plugin.json   # manifest
    └── index.js      # 진입점 모듈
```

- **manifest**: [Plugin Interface의 manifest](PLUGIN_INTERFACE.md#manifest)입니다. Daemon은 진입점 모듈을 불러오기 전에 manifest만 읽고 불러올지 정합니다.
- **진입점 모듈**: ES 모듈 하나로 번들합니다. Plugin이 쓰는 라이브러리는 모두 이 모듈 안에 넣으며, 번들 밖에서는 Daemon 런타임의 내장 모듈만 가져옵니다. `plugin`이라는 이름으로 [`Plugin`](PLUGIN_INTERFACE.md#plugin)을 구현한 객체를 내보냅니다(named export).
- **불러오기만으로는 아무 일도 하지 않습니다.** 진입점 모듈의 최상위 코드에서 파일을 읽거나, 감시를 시작하거나, 타이머를 걸지 않습니다. 이런 일은 `start`에서 시작합니다.

```ts
// Plugin 진입점 모듈의 소스
import type { Plugin, PluginContext } from "plugin-api";

export const plugin: Plugin = {
  async start(context: PluginContext) {
    // Trigger를 설정합니다. 수집한 Batch는 context.submit으로 넘깁니다.
  },
  async stop() {
    // Trigger를 해제하고 진행 중인 수집을 멈춥니다.
  },
};
```

Plugin을 빌드할 때 manifest의 `api_version`은 빌드에 쓴 Plugin API의 `PLUGIN_API_VERSION`으로, `version`은 Plugin 패키지의 버전으로 채웁니다.

### Daemon이 Plugin을 불러오는 방식

Daemon은 시작할 때 설정의 "사용할 Plugin"에 있는 에이전트 id마다 다음을 수행합니다.

1. `<Plugin 디렉터리>/<에이전트 id>/plugin.json`을 읽습니다.
2. manifest의 `agent`가 에이전트 id와 같고, `api_version`이 Daemon이 빌드에 쓴 `PLUGIN_API_VERSION`과 같은지 확인합니다.
3. manifest의 `main`이 가리키는 진입점 모듈을 동적 `import()`로 불러옵니다. `main`은 그 Plugin 디렉터리 밖을 가리킬 수 없습니다.
4. 모듈이 내보낸 `plugin`에 `start`와 `stop` 함수가 있는지 확인합니다.
5. `plugin.start`를 부릅니다. 이 Plugin이 넘긴 Batch의 `source.agent`와 `source.plugin_version`은 manifest의 `agent`와 `version`으로 채웁니다.

- 어느 단계에서든 실패하면 Daemon은 로그를 남기고 그 Plugin을 불러오지 않습니다. 다른 Plugin은 그대로 불러오며, Daemon은 계속 실행합니다.
- "사용할 Plugin"에 없는 Plugin은 Plugin 디렉터리에 있어도 진입점 모듈을 불러오지 않습니다.
- Daemon은 Trigger를 모르므로 어느 에이전트의 Session Log를 언제 수집할지 알 수 없습니다. 그래서 Plugin은 수집할 때가 아니라 Daemon이 시작할 때 불러오며, 그 뒤 수집은 Plugin의 Trigger를 따릅니다.

### Plugin 추가하기

1. 에이전트의 Plugin 패키지를 만들고, Plugin API에 맞춰 구현합니다.
2. Plugin을 빌드해 [빌드한 Plugin](#빌드한-plugin)의 디렉터리를 만듭니다.
3. 그 디렉터리를 Plugin 디렉터리에 넣습니다. Plugin을 고칠 때는 디렉터리를 통째로 바꿉니다.
4. 설정의 "사용할 Plugin"에 에이전트 id를 넣습니다.
5. Daemon을 다시 시작합니다.
6. [에이전트별 문서](#에이전트별-문서)를 추가합니다.

위 예시의 패키지 이름 `plugin-api`는 예시입니다.

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
- 패키지 이름과 저장소 구성. Plugin 패키지를 Daemon과 같은 저장소에 둘지, 따로 둘지
- 패키지 관리 도구와 Plugin을 번들하는 도구
- 빌드한 Plugin을 에이전트 머신에 배포하는 방법
- Plugin 디렉터리의 Plugin을 믿을 수 있는지 확인하는 방법(예: 서명 검증)
- Daemon을 다시 시작하지 않고 Plugin을 추가하거나 바꾸는 방법
