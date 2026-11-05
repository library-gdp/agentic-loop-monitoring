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

지금은 OpenCode 1.19.x만 수집합니다. Claude Code와 Codex는 아직 구현하지 않았습니다. OpenCode가 기록하지 않는 시스템 프롬프트, 지침 파일, 도구 정의는 볼 수 없습니다([OpenCode Plugin](docs/002.implementation/006.plugin/003.OPENCODE.md#input-기록-범위) 참고).

## 실행

[Bun](https://bun.sh) 1.4.4 이상이 필요합니다. 지원 플랫폼은 Linux x64, Linux arm64, macOS arm64입니다.

```sh
bun install
bun run build

# Plugin을 Plugin 디렉터리에 넣습니다.
mkdir -p ~/.local/share/agentic-loop-monitoring/plugins
cp dist/plugins/opencode.js ~/.local/share/agentic-loop-monitoring/plugins/

# 실행합니다. 설정 파일이 없으면 기본값으로 동작합니다.
./dist/alm run

# 다른 터미널에서 브라우저로 열 접속 URL을 출력합니다.
./dist/alm url
```

상주시키려면 `./dist/alm service install`로 서비스 파일을 만들고 `systemctl --user enable --now agentic-loop-monitoring`을 실행합니다. macOS에서는 만들어진 plist를 `launchctl load`합니다.

설정은 `~/.config/agentic-loop-monitoring/config.toml`에 둡니다. 항목은 [Client Adapter Daemon 구현](docs/002.implementation/007.CLIENT_ADAPTER_DAEMON.md#설정)을 참고하세요.

```toml
# OpenCode DB가 기본 위치가 아닐 때
[plugins.opencode]
database = "/path/to/opencode.db"
```

이 도구는 프롬프트와 도구 결과의 원문을 마스킹 없이 저장합니다.
