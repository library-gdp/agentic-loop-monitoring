# OPENCODE.md

이 문서는 OpenCode의 작업을 Agentic Loop Monitoring으로 수집하고 보는 방법을 사용자의 입장에서 설명합니다. 설치, 설정, 실행, 결과 보기, 문제 해결을 다루며, 그 과정에서 OpenCode Plugin이 무엇을 하고 무엇을 하지 않는지 함께 설명합니다. 용어는 [Glossary](../docs/001.model/002.GLOSSARY.md)를 따릅니다.

> 아직 릴리스한 버전이 없습니다. 이 매뉴얼은 `docs/`의 설계와 [PR #28](https://github.com/library-gdp/agentic-loop-monitoring/pull/28)의 구현 초안을 바탕으로, 완성되었을 때의 사용 방법을 미리 적은 것입니다. 명령 이름(`alm`), 설정 키, 기본 경로, 화면 구성은 PR #28의 제안이며 main에 병합되지 않았습니다. 항목별 확정 여부는 [근거와 확정 여부](#근거와-확정-여부)를 참고하세요.

## 개요

OpenCode는 작업 내용을 SQLite DB(`opencode.db`)에 기록합니다. OpenCode Plugin은 이 DB를 읽기만 해서 Session Log Event로 바꾸고, Main Server는 이를 저장해 Turn, Loop, LLM Call, Tool Call 단위로 보여 줍니다.

```
┌──────────┐ 기록  ┌─────────────┐ 읽기  ┌──────────────────────── alm run (프로세스 하나) ────────────────────────┐
│ OpenCode │ ────▶ │ opencode.db │ ────▶ │ OpenCode Plugin ─▶ Client Adapter Daemon ─▶ Main Server ─▶ data.db │
└──────────┘       └─────────────┘       └──────────────────────────────────────────────────────────┬──────────┘
                                                                                                    │ 127.0.0.1
                                                                                               ┌────▼────┐
                                                                                               │ 브라우저 │
                                                                                               └─────────┘
```

- **OpenCode에 아무것도 설치하지 않습니다.** OpenCode의 설정, 플러그인, 환경 변수를 바꾸지 않습니다. OpenCode는 이 도구가 있는지 모릅니다.
- **OpenCode를 기다리게 하지 않습니다.** 이 도구가 꺼져 있거나 실패해도 OpenCode는 그대로 동작합니다. 대신 일부 기록을 놓칠 수 있습니다([System Architecture](../docs/001.model/001.SYSTEM_ARCHITECTURE.md#principles)의 Observe-only, Fail-open).
- **`opencode.db`를 바꾸지 않습니다.** 읽기 전용 연결로 읽으며 OpenCode의 기록을 막는 잠금을 걸지 않습니다.
- **원문을 그대로 저장합니다.** 프롬프트, 모델 응답, 도구 결과를 마스킹하지 않습니다([데이터와 보안](#데이터와-보안) 참고).
- **사후 분석용입니다.** LLM Call은 OpenCode가 그 응답을 끝낸 뒤에 나타납니다. 진행 중인 응답을 실시간으로 보여 주지 않습니다([언제 나타나는가](#언제-나타나는가) 참고).

## 요구 사항

| 항목 | 요구 사항 |
|---|---|
| OpenCode | 1.19.x. 1.19.5에서 확인했습니다. 2.x는 DB의 이벤트 형식이 달라 수집하지 않습니다. |
| 플랫폼 | Linux x64, Linux arm64, macOS arm64. Windows는 지원하지 않습니다. |
| 실행 계정 | OpenCode를 쓰는 사용자 계정. 계정마다 하나씩 실행합니다. |
| Bun | 소스에서 빌드할 때만 필요합니다. 1.4.4 이상입니다. |

OpenCode 버전은 `opencode --version`으로 확인합니다.

## 설치

설치하는 것은 실행 파일 `alm` 하나와 OpenCode Plugin 파일 `opencode.js` 하나입니다. Plugin은 실행 파일과 따로 배포되며, `alm`은 시작할 때 Plugin 디렉터리에서 이 파일을 불러옵니다([Plugin Guide](../docs/002.implementation/004.PLUGIN_GUIDE.md#plugin을-daemon에-넣는-방식) 참고).

### 릴리스에서 설치

GitHub Releases에 플랫폼별 `alm` 실행 파일, `opencode.js`, SHA-256 체크섬이 올라갑니다. 설치 절차(설치 스크립트 제공 여부 등)는 아직 정하지 않았으며, 수동으로 설치하면 다음과 같습니다.

```sh
# 내려받은 파일을 체크섬으로 확인합니다.
sha256sum -c SHA256SUMS            # macOS: shasum -a 256 -c SHA256SUMS

# 실행 파일을 PATH에 둡니다.
install -m 0755 alm-linux-x64 ~/.local/bin/alm

# Plugin을 Plugin 디렉터리에 둡니다.
mkdir -p ~/.local/share/agentic-loop-monitoring/plugins
cp opencode.js ~/.local/share/agentic-loop-monitoring/plugins/
```

릴리스 파일 이름(`alm-linux-x64`, `SHA256SUMS`)은 예시입니다.

### 소스에서 빌드

```sh
bun install
bun run build    # dist/alm, dist/plugins/opencode.js를 만듭니다.

install -m 0755 dist/alm ~/.local/bin/alm
mkdir -p ~/.local/share/agentic-loop-monitoring/plugins
cp dist/plugins/opencode.js ~/.local/share/agentic-loop-monitoring/plugins/
```

### Plugin 바꾸기

새 `opencode.js`로 파일을 바꾼 뒤 `alm`을 다시 시작합니다. 실행 파일은 다시 설치하지 않아도 됩니다. 실행 파일과 Plugin의 Plugin API 버전이 다르면 `alm`은 그 Plugin을 불러오지 않고 로그를 남깁니다([Plugin Interface](../docs/002.implementation/005.PLUGIN_INTERFACE.md#plugin-api-버전) 참고).

## 설정

설정 파일이 없으면 모든 항목을 기본값으로 실행합니다. OpenCode를 기본 설치대로 쓰고 있다면 설정 없이 시작해도 됩니다.

설정 파일은 TOML이며 기본 위치는 `~/.config/agentic-loop-monitoring/config.toml`입니다. 다른 파일을 쓰려면 `--config <경로>`를 줍니다.

```toml
# 사용할 Plugin. 기본값은 ["opencode"]입니다.
enabled_plugins = ["opencode"]

[plugins.opencode]
# OpenCode DB가 기본 위치가 아닐 때만 적습니다.
database = "/path/to/opencode.db"

[visualization]
# 0이면 운영체제가 빈 포트를 고릅니다.
port = 0
```

### 설정 항목

| 키 | 기본값 | 설명 |
|---|---|---|
| `enabled_plugins` | `["opencode"]` | 시작할 Plugin의 에이전트 id 목록입니다. |
| `plugins.opencode.database` | 아래 [OpenCode DB 위치](#opencode-db-위치) | 수집할 OpenCode DB의 경로입니다. |
| `plugin_directory` | `$XDG_DATA_HOME/agentic-loop-monitoring/plugins` | `opencode.js`를 두는 디렉터리입니다. |
| `data_file` | `$XDG_DATA_HOME/agentic-loop-monitoring/data.db` | 수집한 데이터를 저장하는 SQLite 파일입니다. |
| `state_directory` | `$XDG_STATE_HOME/agentic-loop-monitoring` | 로그, 잠금 파일, 접속 정보, Plugin의 수집 위치를 두는 디렉터리입니다. |
| `visualization.port` | `0` | 브라우저로 접속할 포트입니다. 주소는 항상 `127.0.0.1`입니다. |
| `transport.ack_timeout_ms` | `10000` | Main Server의 저장 응답을 기다리는 최대 시간입니다. |
| `transport.retry_count` | `5` | 저장에 실패했을 때 다시 보내는 횟수입니다. |
| `transport.retry_interval_ms` | `500` | 첫 재시도 간격입니다. 재시도마다 두 배로 늘어납니다. |
| `storage.busy_timeout_ms` | `5000` | 쓰기 잠금을 기다리는 최대 시간입니다. `transport.ack_timeout_ms`보다 짧아야 합니다. |

`$XDG_DATA_HOME`, `$XDG_STATE_HOME`, `$XDG_CONFIG_HOME`의 기본값은 각각 `~/.local/share`, `~/.local/state`, `~/.config`이며 macOS에서도 같습니다.

Daemon과 Main Server를 다른 프로세스로 나누는 설정(`role`, `transport.kind = "rest"`)도 있지만, 혼자 쓸 때는 필요하지 않습니다. 이 Transport에는 인증이 없습니다.

### OpenCode DB 위치

Plugin은 다음 순서로 DB를 찾습니다. 앞의 것이 있으면 뒤의 것은 보지 않습니다.

| 순서 | 위치 |
|---|---|
| 1 | 설정의 `plugins.opencode.database`. 상대 경로는 `$XDG_DATA_HOME/opencode/` 기준입니다. |
| 2 | `alm`을 실행한 환경의 `OPENCODE_DB` 환경 변수. 기준은 위와 같습니다. |
| 3 | `$XDG_DATA_HOME/opencode/opencode.db` |

다음 경우에는 `database`를 직접 적어야 합니다.

- **OpenCode에 `OPENCODE_DB`를 설정해 쓰는 경우**: `alm`은 OpenCode와 다른 환경에서 실행되므로(특히 서비스로 상주할 때) OpenCode의 환경 변수를 보지 못합니다.
- **`latest`, `beta`, `prod`가 아닌 채널의 OpenCode를 쓰는 경우**: OpenCode는 `opencode-<채널>.db`에 기록하지만 Plugin은 채널을 알 수 없습니다.

`OPENCODE_DB`가 `:memory:`이면 OpenCode가 파일에 기록하지 않으므로 수집할 수 없습니다. DB를 하나만 수집할 수 있으며, 여러 DB를 함께 수집하는 방법은 아직 없습니다.

## 실행

### 앞에서 실행

```sh
alm run
```

터미널을 닫거나 `Ctrl+C`를 누르면 멈춥니다. 멈출 때는 Plugin을 멈추고, 아직 저장하지 못한 데이터를 최대 5초 동안 마저 저장한 뒤 끝냅니다. 그 안에 저장하지 못한 것은 로그를 남기고 버리며, 다음에 시작할 때 다시 수집합니다.

같은 `state_directory`를 쓰는 `alm`이 이미 실행 중이면 새로 시작하지 않고 끝납니다.

### 상주시키기

`alm service install`은 서비스 파일만 만듭니다. 서비스를 켜는 일은 사용자가 합니다.

```sh
# Linux: ~/.config/systemd/user/agentic-loop-monitoring.service를 만듭니다.
alm service install
systemctl --user daemon-reload
systemctl --user enable --now agentic-loop-monitoring

# macOS: ~/Library/LaunchAgents/agentic-loop-monitoring.plist를 만듭니다.
alm service install
launchctl load ~/Library/LaunchAgents/agentic-loop-monitoring.plist
```

- 실패하면 다시 시작합니다. Linux에서는 메모리 상한(`MemoryMax=256M`)을 겁니다.
- `--config`를 주고 `service install`을 실행하면 서비스도 그 설정 파일로 실행합니다.
- 로그인한 동안만 실행하는 user service입니다. 로그아웃 뒤에도 실행하려면 `loginctl enable-linger`를 따로 설정합니다.

### 꺼져 있던 동안의 기록

`alm`이 꺼져 있던 동안 OpenCode가 기록한 내용은 다음에 시작할 때 수집합니다. Plugin은 Session마다 어디까지 수집했는지 `state_directory`에 저장해 두고, 시작할 때 그 뒤부터 읽습니다. 그 사이 OpenCode에서 Session을 지웠다면 그 Session은 수집하지 못합니다.

처음 시작할 때는 DB에 남아 있는 모든 Session을 수집합니다. OpenCode를 오래 썼다면 첫 수집에 시간이 걸릴 수 있습니다.

## 결과 보기

### 접속

```sh
alm url
# http://127.0.0.1:43127/?token=...
```

출력된 URL을 브라우저로 엽니다. 처음 접속하면 브라우저에 쿠키가 저장되고 토큰이 없는 주소로 옮겨 갑니다.

- `127.0.0.1`에서만 접속할 수 있습니다. 다른 머신에서는 접속할 수 없습니다.
- 토큰은 같은 머신의 다른 계정이 데이터를 보지 못하게 막습니다. URL을 공유하지 마세요.
- `alm`을 다시 시작하면 포트와 토큰이 바뀝니다. 다시 `alm url`을 실행합니다.

### 화면

| 화면 | 보이는 것 |
|---|---|
| Session 목록 | 시작 시각순. 첫 프롬프트, Agent 수, Turn 수, `completed`가 아닌 Turn 수, Token 합계. 작업 디렉터리(`cwd`)로 거를 수 있습니다. |
| Session | Main Agent와 Subagent의 트리, 선택한 Agent의 Turn 목록(`status`, 프롬프트, Loop 수, Tool Call 수, 오류 수, 걸린 시간, Token 합계). Session을 지울 수 있습니다. |
| Turn | 프롬프트, Loop와 Compaction별 Token Usage 차트, 순서대로 놓인 Loop와 Compaction |
| Loop | 모델, Stop Reason, 걸린 시간, Token Usage, LLM 호출 오류, Tool Call. LLM Call의 input과 output, Tool Call의 인자와 결과는 펼칠 때 불러옵니다. Subagent를 띄운 Tool Call에서 그 Subagent로 갑니다. |

### 실패한 작업 되짚기

이 도구의 목적은 사람이 실패라고 판단한 작업의 원인을 찾는 것입니다([Intent](../intent/INTENT-1.0.md#proposed-outcome)).

1. **Session 찾기**: Session 목록에서 작업 디렉터리와 첫 프롬프트로 그 작업의 Session을 찾습니다. `completed`가 아닌 Turn 수가 있는 Session은 오류나 중단이 있었던 것입니다.
2. **Turn 고르기**: Session 화면에서 결과가 잘못된 Turn을 고릅니다. Subagent가 한 일이면 Agent 트리에서 그 Subagent를 고릅니다.
3. **Loop 따라가기**: Turn 화면에서 Loop를 처음부터 따라가며 어떤 도구를 왜 불렀는지 봅니다.
4. **판단 지점 확인**: 의심되는 Loop에서 LLM Call의 input을 펼쳐, 모델이 그 판단을 내릴 때 무엇을 보고 있었는지 확인합니다. input은 직전 compaction 이후 그 Agent가 받은 프롬프트, 모델 응답, 도구 결과입니다.
5. **토큰 보기**: Turn 화면의 차트에서 Token이 크게 늘어난 Loop를 찾고, 그 Loop의 도구 결과나 input을 확인합니다.

input에 시스템 프롬프트, AGENTS.md, 도구 정의는 들어 있지 않습니다. OpenCode가 이를 DB에 기록하지 않기 때문입니다([볼 수 없는 것](#볼-수-없는-것) 참고).

## OpenCode의 작업이 보이는 방식

OpenCode의 작업은 다음과 같이 나타납니다. 자세한 변환 규칙은 [OpenCode Plugin](../docs/002.implementation/006.plugin/003.OPENCODE.md)에 있습니다.

| OpenCode에서 | 이 도구에서 |
|---|---|
| 사용자가 시작한 session | Session, 그리고 그 Main Agent |
| `task` 도구가 만든 child session | 같은 Session 안의 Subagent. 자신을 띄운 Agent 아래에 놓입니다. |
| 사용자가 입력한 프롬프트 | Turn의 시작 |
| `/compact`처럼 사용자가 요청한 compaction | 프롬프트가 빈 Turn과 그 안의 Compaction |
| 모델 응답 한 번(`step-start`가 있는 assistant message) | LLM Call 하나, 그리고 Loop 하나 |
| 모델이 요청한 도구 실행 | 그 LLM Call의 Tool Call |
| 자동 compaction | 진행 중인 Turn 안의 Compaction |
| compaction 뒤 이어 가라는 지시 같은 OpenCode의 지시문 | 뒤 LLM Call의 input. Turn을 시작하지 않습니다. |
| 사용자 shell(`!` 명령), subtask | 뒤 LLM Call의 input. 모델이 요청한 것이 아니므로 Tool Call로 나타나지 않습니다. |
| 첨부 파일 | input에 `[Attached <mime>: <파일 이름>]`로 표시합니다. 파일 내용은 싣지 않습니다. |

### Turn의 `status`

| `status` | OpenCode에서 일어난 일 |
|---|---|
| `completed` | 모델이 도구를 더 부르지 않고 응답을 끝냈습니다. |
| `interrupted` | 사용자가 응답을 중단했습니다. 중단 전까지 받은 내용은 남습니다. |
| `errored` | 모델 호출이 오류로 끝났거나, 응답이 끝나지 않은 채 다음 프롬프트가 시작되었습니다. |
| `in_progress` | 아직 진행 중입니다. 오래 이렇게 남아 있으면 OpenCode가 그 Turn 도중 종료된 것입니다. |

OpenCode는 다시 시도할 수 있는 오류(rate limit 등)를 DB에 남기지 않고 같은 응답 안에서 다시 요청합니다. 그래서 보이는 오류는 모두 OpenCode가 포기한 오류이며, 실패한 시도는 LLM Call로 보이지 않습니다.

## 언제 나타나는가

Plugin은 OpenCode가 DB에 커밋할 때마다 수집을 시작하며, 알림을 놓칠 때에 대비해 30초마다 한 번 더 확인합니다. 그래도 다음은 곧바로 나타나지 않습니다.

| 기록 | 나타나는 때 |
|---|---|
| LLM Call과 그 Tool Call | OpenCode가 그 응답을 끝내고 응답 안의 도구가 모두 끝났을 때. 오래 실행되는 도구가 있으면 그 도구가 끝날 때까지 나타나지 않습니다. |
| Subagent를 띄운 Tool Call | Subagent가 일을 마치고 부모의 응답이 끝났을 때. Subagent 자신의 Turn과 LLM Call은 그보다 먼저 나타납니다. |
| 사용자 프롬프트 | OpenCode가 그 다음 메시지를 시작했을 때 |
| 사용자 shell 결과 | 다음 프롬프트를 입력했을 때. 다음 프롬프트가 없으면 나타나지 않습니다. |

## 볼 수 없는 것

OpenCode가 DB에 기록하지 않는 것은 보여 주지 않으며, 이 도구가 만들어 내지도 않습니다.

| 볼 수 없는 것 | 이유 |
|---|---|
| 시스템 프롬프트, AGENTS.md 같은 지침 파일, 도구 정의 | OpenCode가 요청할 때마다 메모리에서 조합하고 DB에 남기지 않습니다. |
| 시스템 프롬프트에 넣은 Skill 목록, reminder | 같습니다. Skill을 도구로 불러 읽은 내용은 Tool Call 결과로 보입니다. |
| 첨부 파일의 내용 | DB에는 있지만 싣지 않습니다. 파일 이름과 형식만 보입니다. |
| 실패한 재시도, 재시도 횟수 | OpenCode가 기록하지 않습니다. |
| compaction 직전의 컨텍스트 크기 | OpenCode가 기록하지 않습니다. |
| 제목과 요약을 만드는 LLM 호출, 그 Token | OpenCode가 message로 기록하지 않습니다. 그래서 Token 합계가 실제 청구량보다 적을 수 있습니다. |
| provider가 암호화한 reasoning | DB에 내용이 없습니다. |
| OpenCode가 강제 종료될 때 쓰던 응답의 text, reasoning | 끝나기 전에는 DB에 내용이 없습니다. |

다음은 보이는 input과 모델이 실제로 받은 input이 다를 수 있는 경우입니다.

- **compaction 뒤에 남긴 최근 기록**: OpenCode는 compaction 뒤에도 최근 Turn 일부를 요약하지 않고 남길 수 있습니다. 이 도구의 input은 compaction에서 시작하므로 그 부분이 보이지 않습니다.
- **prune된 도구 결과**: OpenCode가 오래된 도구 결과를 컨텍스트에서 지워도, 이 도구에는 원래 결과가 그대로 남습니다.
- **오류로 끝난 응답**: OpenCode는 다음 요청에 넣지 않지만, 이 도구의 뒤 LLM Call input에는 나타납니다.

## 데이터와 보안

- **저장 위치**: 수집한 데이터는 `data_file`(기본 `~/.local/share/agentic-loop-monitoring/data.db`) 하나에 있습니다. 프롬프트, 소스 코드, 도구 결과의 원문이 마스킹 없이 들어 있으므로 이 파일을 공유하지 마세요.
- **네트워크**: 기본 구성은 아무것도 외부로 보내지 않습니다. 브라우저 접속도 `127.0.0.1`만 받습니다.
- **`state_directory`의 파일**

  | 파일 | 내용 |
  |---|---|
  | `daemon.log` | `alm`과 Plugin의 로그 |
  | `daemon.lock` | 같은 상태 디렉터리로 두 번 실행하지 않게 하는 잠금 |
  | `visualization.json` | 접속 주소와 토큰. 권한 `0600`입니다. |
  | `plugins/opencode/positions.json` | Session마다 어디까지 수집했는지 |

- **Session 지우기**: Session 화면에서 지울 수 있습니다. 이 도구의 데이터만 지우며 OpenCode의 기록은 그대로입니다. 지운 뒤 OpenCode에서 그 Session을 이어 쓰거나 수집 위치를 지우면 다시 나타날 수 있습니다.

## 문제 해결

먼저 `state_directory`의 `daemon.log`를 봅니다. Plugin의 로그에는 `opencode`가 붙어 있습니다.

| 증상 | 확인할 것 |
|---|---|
| Session이 하나도 나타나지 않음 | `opencode.js`가 `plugin_directory` 바로 아래에 있는지, `enabled_plugins`에 `opencode`가 있는지, 로그에 Plugin을 불러오지 못했다는 기록이 없는지 확인합니다. |
| 로그에 DB를 찾을 수 없다고 나옴 | [OpenCode DB 위치](#opencode-db-위치)를 확인합니다. OpenCode에서 `OPENCODE_DB`나 채널을 바꿔 쓰고 있다면 `database`를 적습니다. OpenCode를 한 번도 실행하지 않았으면 DB가 없습니다. 생기면 30초 안에 수집을 시작합니다. |
| 로그에 `event` 테이블이 없다고 나옴 | OpenCode 버전을 확인합니다. 1.19.x가 아니면 수집하지 않습니다. |
| 일부 Session만 나타나지 않음 | OpenCode 2.x에서 기록한 Session이거나, 이 도구에서 지운 Session일 수 있습니다. |
| 방금 한 작업이 보이지 않음 | [언제 나타나는가](#언제-나타나는가)를 확인합니다. 응답이 끝나지 않았거나 도구가 실행 중일 수 있습니다. |
| Turn이 계속 `in_progress` | OpenCode가 그 Turn 도중 종료되었을 수 있습니다. 같은 session에서 다음 응답이 시작되면 남은 내용이 넘어갑니다. |
| 중단하지 않았는데 Turn이 `errored` | 큰 컨텍스트 때문에 OpenCode가 compaction한 뒤 원래 프롬프트를 다시 넣으면, 다시 넣은 프롬프트가 새 Turn이 되고 앞 Turn은 `errored`로 보입니다. |
| Subagent가 나타나지 않음 | 부모 session을 아직 찾지 못하면 Subagent가 어느 Session에 속하는지 정할 수 없어 수집을 미룹니다. 로그에 기록이 남고, 다음 수집에서 다시 시도합니다. |
| 브라우저에서 `401` | `alm`이 다시 시작되어 토큰이 바뀌었습니다. `alm url`로 새 URL을 엽니다. |
| `alm run`이 곧바로 끝남 | 다른 `alm`이 같은 `state_directory`로 실행 중입니다. 서비스로 상주 중인지 확인합니다. |
| 처음부터 다시 수집하고 싶음 | `alm`을 멈추고 `plugins/opencode/positions.json`을 지운 뒤 시작합니다. 이미 저장한 것은 중복으로 저장하지 않습니다. |

## 제거

```sh
# 상주를 멈춥니다.
systemctl --user disable --now agentic-loop-monitoring   # macOS: launchctl unload <plist 경로>
alm service uninstall

# 데이터, 상태, 설정, Plugin을 지웁니다.
rm -rf ~/.local/share/agentic-loop-monitoring ~/.local/state/agentic-loop-monitoring ~/.config/agentic-loop-monitoring
rm ~/.local/bin/alm
```

OpenCode에는 설치한 것이 없으므로 OpenCode에서 지울 것은 없습니다.

## 근거와 확정 여부

| 내용 | 근거 | 상태 |
|---|---|---|
| OpenCode에 설치하지 않고 DB를 읽기만 함, WAL 변경 감시와 30초 주기, 꺼져 있던 동안의 기록 수집 | [OpenCode Plugin](../docs/002.implementation/006.plugin/003.OPENCODE.md#trigger) | main에서 정함 |
| 대상 버전 1.19.x, 기본 DB 위치, `OPENCODE_DB` | [OpenCode Plugin](../docs/002.implementation/006.plugin/003.OPENCODE.md#대상-버전) | main에서 정함 |
| Main Agent와 Subagent의 구분 | [OpenCode Plugin](../docs/002.implementation/006.plugin/003.OPENCODE.md#session-id와-agent-id) | main에서 정함 |
| 실행 파일 하나와 따로 배포하는 Plugin, 지원 플랫폼, systemd와 launchd, GitHub Releases | [Tech Stack](../docs/002.implementation/001.TECH_STACK.md), [Plugin Guide](../docs/002.implementation/004.PLUGIN_GUIDE.md) | main에서 정함 |
| `127.0.0.1` 바인딩, 접근 토큰과 쿠키, 포트 기본값 `0` | [Visualization](../docs/002.implementation/010.VISUALIZATION.md#접속) | main에서 정함 |
| Turn `status`의 뜻 | [Turn](../docs/001.model/003.domain_model/006.TURN.md#구성-규칙) | main에서 정함 |
| 명령 `alm run`, `alm url`, `alm service install`, 설정 키와 기본값, 상태 디렉터리의 파일 이름 | PR #28 | 제안(미병합) |
| OpenCode message를 끝날 때 변환, `context_message`, 사용자 shell과 subtask의 처리, 오류와 중단의 구분 | PR #28, ADR `convert-opencode-messages-when-they-finish`(proposed) | 제안(미병합) |
| 볼 수 없는 것과 input이 실제와 다른 경우 | PR #28의 OpenCode Plugin 문서 "input 기록 범위" | 제안(미병합) |
| 화면 구성 | PR #28의 Visualization 문서 "화면" | 제안(미병합) |
| `database` 설정 | main은 "경로를 받을 설정이 필요하다"고만 적었고, 키는 PR #28이 정했습니다. | 제안(미병합) |
| 릴리스 파일 이름과 설치 절차 | [Plugin Guide](../docs/002.implementation/004.PLUGIN_GUIDE.md#결정되지-않은-사항) | 정하지 않음 |

## 결정되지 않은 사항

이 매뉴얼에 영향을 주지만 아직 정하지 않은 것입니다.

- **사용자가 중단한 Turn**: [Intent](../intent/INTENT-1.0.md#constraints)는 수집하지 않고 버린다고 하지만, [Turn](../docs/001.model/003.domain_model/006.TURN.md)은 `interrupted`로 저장합니다. 이 매뉴얼과 PR #28은 Turn 문서를 따랐습니다.
- **실제 기록으로 확인하지 않은 동작**: 실제 OpenCode 1.19.5 DB에는 정상 종료한 Turn만 있었습니다. Subagent, compaction, 오류, 중단, 사용자 shell, subtask가 위와 같이 보이는지는 소스를 읽고 만든 테스트로만 확인했습니다.
- **macOS**: 파일 감시와 launchd 등록을 macOS에서 시험하지 않았습니다.
- 오래 실행되는 도구를 끝나기 전에 보여 줄지
- 설치 절차와 Plugin의 서명 검증
- 여러 OpenCode DB를 함께 수집하는 방법
- 백업 방법
