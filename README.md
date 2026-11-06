# Agentic Loop Monitoring

AI 에이전트의 에이전틱 루프를 추적해 작업 과정과 토큰 사용량, 작업 시간 등의 metric을 시각화하는 모니터링 도구

## Overview

Agentic Loop Monitoring은 Codex, Claude Code, Open Code 같은 AI 에이전트가 작업을 어떻게 수행했는지 확인하기 위한 모니터링 도구입니다. AI 에이전트는 LLM API 호출과 Tool Request를 반복하는 에이전트 루프로 작업을 처리합니다. 하지만 이 과정은 사용자에게 드러나지 않아서 에이전트가 각 단계에서 무엇을 했고 자원을 얼마나 썼는지 알기 어렵습니다.

이 프로젝트는 에이전트 루프 안에서 일어나는 LLM API 호출과 Tool Request를 추적합니다. 이 과정에서 토큰 사용량과 작업 시간 같은 metric을 수집하고, 수집한 데이터를 루프 단위로 시각화합니다. 이를 통해 AI 에이전트를 사용하는 개발자는 에이전트의 동작 과정과 자원 사용량을 구체적으로 확인할 수 있습니다.

## Features

- **에이전틱 루프 모니터링**: AI 에이전트가 작업 중에 반복하는 LLM API 호출과 Tool Request를 추적해 에이전트 루프가 실제로 어떻게 진행되는지 보여줍니다.
- **Metric 수집**: 에이전트 작업 중에 발생하는 토큰 사용량, 작업 시간 등의 metric을 수집합니다.
- **루프별 시각화**: 각 루프에서 수행한 작업 내용과 토큰 소모량 등을 시각화해 루프 단위로 에이전트의 동작과 자원 사용을 비교할 수 있게 합니다.

## 지원하는 에이전트

| 에이전트 | 상태 |
|---|---|
| OpenCode 1.19.x | 지원합니다. 1.19.5에서 확인했습니다. 2.x는 DB 형식이 달라 수집하지 않습니다. |
| Claude Code, Codex | 아직 구현하지 않았습니다. |

지원 플랫폼은 Linux x64, Linux arm64, macOS arm64입니다. Windows는 지원하지 않습니다.

## 동작 방식

```
OpenCode ──기록──▶ opencode.db ──읽기──▶ alm (OpenCode Plugin → Daemon → Main Server → data.db) ──▶ 브라우저(127.0.0.1)
```

- `alm` 실행 파일 하나가 Client Adapter Daemon과 Main Server를 한 프로세스로 실행합니다. OpenCode Plugin은 따로 빌드한 `opencode.js` 파일이며, `alm`이 시작할 때 Plugin 디렉터리에서 불러옵니다.
- OpenCode에는 아무것도 설치하거나 설정하지 않습니다. Plugin은 OpenCode의 DB를 읽기 전용으로 읽기만 합니다. `alm`이 꺼져 있거나 실패해도 OpenCode는 그대로 동작합니다.
- 사후 분석용입니다. LLM Call은 OpenCode가 그 응답과 응답 안의 도구 실행을 끝낸 뒤에 나타납니다.
- `alm`이 꺼져 있던 동안의 기록은 다음에 시작할 때 이어서 수집합니다. 처음 시작하면 DB에 남아 있는 모든 Session을 수집합니다.

## 설치

### 릴리스에서 설치

[GitHub Releases](https://github.com/library-gdp/agentic-loop-monitoring/releases)에서 플랫폼에 맞는 `alm-<플랫폼>`(`linux-x64`, `linux-arm64`, `darwin-arm64`), `opencode.js`, `SHA256SUMS`를 내려받습니다. 아직 릴리스가 없으면 [소스에서 빌드](#소스에서-빌드)합니다.

```sh
sha256sum -c SHA256SUMS --ignore-missing   # macOS: shasum -a 256 -c SHA256SUMS --ignore-missing

install -m 0755 alm-linux-x64 ~/.local/bin/alm
mkdir -p ~/.local/share/agentic-loop-monitoring/plugins
cp opencode.js ~/.local/share/agentic-loop-monitoring/plugins/
```

### 소스에서 빌드

[Bun](https://bun.sh) 1.4.4 이상이 필요합니다.

```sh
bun install
bun run build    # dist/alm, dist/plugins/opencode.js를 만듭니다.

install -m 0755 dist/alm ~/.local/bin/alm
mkdir -p ~/.local/share/agentic-loop-monitoring/plugins
cp dist/plugins/opencode.js ~/.local/share/agentic-loop-monitoring/plugins/
```

Plugin을 바꿀 때는 `opencode.js`만 바꾸고 `alm`을 다시 시작합니다.

## 실행

### 앞에서 실행

```sh
alm run
```

`Ctrl+C`로 멈춥니다. 멈출 때 아직 저장하지 못한 데이터를 최대 5초 동안 마저 저장합니다. 같은 상태 디렉터리를 쓰는 `alm`이 이미 실행 중이면 시작하지 않고 끝납니다.

### 상주시키기

`alm service install`은 서비스 파일만 만듭니다. 서비스는 직접 켭니다.

```sh
# Linux: ~/.config/systemd/user/agentic-loop-monitoring.service
alm service install
systemctl --user daemon-reload
systemctl --user enable --now agentic-loop-monitoring

# macOS: ~/Library/LaunchAgents/agentic-loop-monitoring.plist
alm service install
launchctl load ~/Library/LaunchAgents/agentic-loop-monitoring.plist
```

- 실패하면 다시 시작합니다. Linux에서는 메모리 상한 `MemoryMax=256M`을 겁니다.
- `--config <경로>`를 함께 주면 서비스도 그 설정 파일로 실행합니다.
- `alm service uninstall`은 서비스 파일을 지웁니다.

### 명령

| 명령 | 내용 |
|---|---|
| `alm run` | Daemon과 Main Server를 실행합니다. |
| `alm url` | 브라우저로 열 접속 URL을 출력합니다. `alm`이 실행 중이어야 합니다. |
| `alm service install` / `uninstall` | systemd user service나 launchd 파일을 만들거나 지웁니다. |
| `alm version` | 버전을 출력합니다. |

모든 명령은 `--config <경로>`를 받습니다.

## 설정

설정 파일이 없으면 모든 항목을 기본값으로 실행합니다. OpenCode를 기본 설치대로 쓴다면 설정 없이 시작해도 됩니다. 기본 위치는 `~/.config/agentic-loop-monitoring/config.toml`입니다.

```toml
# 시작할 Plugin
enabled_plugins = ["opencode"]

[plugins.opencode]
# OpenCode DB가 기본 위치가 아닐 때만 적습니다.
database = "/path/to/opencode.db"

[visualization]
# 0이면 운영체제가 빈 포트를 고릅니다.
port = 0
```

| 키 | 기본값 | 설명 |
|---|---|---|
| `enabled_plugins` | `["opencode"]` | 시작할 Plugin의 에이전트 id |
| `plugins.opencode.database` | 아래 참고 | 수집할 OpenCode DB |
| `plugin_directory` | `~/.local/share/agentic-loop-monitoring/plugins` | `opencode.js`를 두는 디렉터리 |
| `data_file` | `~/.local/share/agentic-loop-monitoring/data.db` | 수집한 데이터를 저장하는 SQLite 파일 |
| `state_directory` | `~/.local/state/agentic-loop-monitoring` | 로그(`daemon.log`), 잠금, 접속 정보, Plugin의 수집 위치 |
| `visualization.port` | `0` | 브라우저로 접속할 포트. 주소는 항상 `127.0.0.1`입니다. |
| `transport.ack_timeout_ms` | `10000` | 저장 응답을 기다리는 최대 시간 |
| `transport.retry_count` | `5` | 저장에 실패했을 때 다시 보내는 횟수 |
| `transport.retry_interval_ms` | `500` | 첫 재시도 간격. 재시도마다 두 배로 늘어납니다. |
| `storage.busy_timeout_ms` | `5000` | 쓰기 잠금을 기다리는 최대 시간. `transport.ack_timeout_ms`보다 짧아야 합니다. |

경로의 기본값은 `$XDG_DATA_HOME`, `$XDG_STATE_HOME`, `$XDG_CONFIG_HOME`을 따릅니다. 전체 항목은 [Client Adapter Daemon 구현](docs/002.implementation/007.CLIENT_ADAPTER_DAEMON.md#설정)을 참고하세요.

### OpenCode DB 위치

Plugin은 다음 순서로 DB를 찾습니다. 상대 경로는 `$XDG_DATA_HOME/opencode/` 기준입니다.

1. 설정의 `plugins.opencode.database`
2. `alm`을 실행한 환경의 `OPENCODE_DB` 환경 변수
3. `~/.local/share/opencode/opencode.db`

OpenCode에 `OPENCODE_DB`를 설정해 쓰거나 `latest`, `beta`, `prod`가 아닌 채널(`opencode-<채널>.db`)을 쓴다면 `database`를 직접 적으세요. 서비스로 상주하는 `alm`은 OpenCode의 환경 변수를 보지 못합니다.

## 사용 방법

### 접속

```sh
alm url
# http://127.0.0.1:43127/?token=...
```

출력된 URL을 브라우저로 엽니다. 처음 접속하면 쿠키가 저장되고 토큰이 없는 주소로 옮겨 갑니다. `127.0.0.1`에서만 접속할 수 있고, `alm`을 다시 시작하면 포트와 토큰이 바뀌므로 다시 `alm url`을 실행합니다. 토큰은 같은 머신의 다른 계정이 데이터를 보지 못하게 막는 값이므로 URL을 공유하지 마세요.

### 화면

| 화면 | 보이는 것 |
|---|---|
| Session 목록 | 시작 시각순. 첫 프롬프트, Agent 수, Turn 수, `completed`가 아닌 Turn 수, Token 합계. 에이전트와 작업 디렉터리(정확히 같은 경로)로 거를 수 있습니다. |
| Session | Main Agent와 Subagent의 트리, 선택한 Agent의 Turn 목록(`status`, 프롬프트, Loop 수, Tool Call 수, 오류 수, 걸린 시간, Token 합계). Session을 지울 수 있습니다. |
| Turn | 프롬프트, Loop와 Compaction별 Token Usage 차트, 순서대로 놓인 Loop와 Compaction |
| Loop | 모델, Stop Reason, 걸린 시간, Token Usage, LLM 호출 오류, Tool Call. LLM Call의 input과 output, Tool Call의 인자와 결과는 펼칠 때 불러옵니다. Subagent를 띄운 Tool Call에서 그 Subagent로 갈 수 있습니다. |

Turn의 `status`는 다음과 같습니다.

| `status` | 뜻 |
|---|---|
| `completed` | 모델이 도구를 더 부르지 않고 응답을 끝냈습니다. |
| `interrupted` | 사용자가 중단했습니다. 중단 전까지의 내용은 남습니다. |
| `errored` | LLM 호출이 오류로 끝났거나, 응답이 끝나지 않은 채 다음 프롬프트가 시작되었습니다. |
| `in_progress` | 아직 진행 중입니다. 오래 이대로라면 OpenCode가 그 Turn 도중 종료된 것입니다. |

### 실패한 작업 되짚기

1. **Session 찾기**: Session 목록에서 작업 디렉터리와 첫 프롬프트로 그 작업의 Session을 찾습니다. `completed`가 아닌 Turn이 있으면 오류나 중단이 있었던 Session입니다.
2. **Turn 고르기**: 결과가 잘못된 Turn을 고릅니다. Subagent가 한 일이면 Agent 트리에서 그 Subagent를 고릅니다.
3. **Loop 따라가기**: Turn의 Loop를 처음부터 따라가며 모델이 어떤 도구를 불렀는지 봅니다.
4. **판단 지점 확인**: 의심되는 Loop에서 LLM Call의 input을 펼쳐, 모델이 그 판단을 내릴 때 무엇을 보고 있었는지 확인합니다. input은 직전 compaction 이후 그 Agent가 받은 프롬프트, 모델 응답, 도구 결과입니다.
5. **토큰 보기**: Turn의 차트에서 Token이 크게 늘어난 Loop를 찾고, 그 Loop의 도구 결과나 input을 확인합니다.

### 볼 수 없는 것

OpenCode가 DB에 기록하지 않는 것은 보여 주지 않습니다.

- 시스템 프롬프트, AGENTS.md 같은 지침 파일, 도구 정의, 시스템 프롬프트에 넣은 Skill 목록
- 실패한 재시도와 재시도 횟수. OpenCode는 다시 시도할 수 있는 오류를 기록하지 않습니다.
- 제목과 요약을 만드는 LLM 호출과 그 Token. 그래서 Token 합계가 실제 청구량보다 적을 수 있습니다.
- 텍스트가 아닌 첨부 파일의 내용. 이름과 형식만 보입니다.

자세한 내용은 [OpenCode Plugin](docs/002.implementation/006.plugin/003.OPENCODE.md#input-기록-범위)을 참고하세요.

## 데이터와 보안

- 프롬프트, 소스 코드, 도구 결과의 원문을 마스킹 없이 `data_file`에 저장합니다. 이 파일을 공유하지 마세요.
- 기본 구성은 외부로 아무것도 보내지 않습니다. 접속도 `127.0.0.1`만 받습니다.
- Session 화면에서 Session을 지우면 이 도구의 데이터만 지워지고 OpenCode의 기록은 그대로입니다. 그 Session을 OpenCode에서 이어 쓰면 그 뒤의 기록은 다시 수집됩니다.

## 개발

| 명령 | 내용 |
|---|---|
| `bun install` | 의존성 설치 |
| `bun test` | 테스트 |
| `bun run typecheck` | 타입 검사 |
| `bun run lint` | Biome 검사. `bun run format`은 자동 수정입니다. |
| `bun run build` | `dist/alm`과 `dist/plugins/opencode.js`를 빌드 |
| `bun run dev` | 소스로 실행. 설치한 `alm`과 섞이지 않도록 임시 디렉터리를 쓰며, 접속 URL을 얻는 명령을 출력합니다. |

설계 문서는 [docs/](docs/)에, 프로젝트의 목적은 [intent/](intent/INTENT-1.0.md)에 있습니다.
