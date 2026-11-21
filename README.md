# Agentoscope

AI 에이전트의 에이전틱 루프를 추적해 작업 과정과 토큰 사용량, 작업 시간 등의 metric을 시각화하는 모니터링 도구

## Overview

Agentoscope는 Codex, Claude Code, Open Code 같은 AI 에이전트가 작업을 어떻게 수행했는지 확인하기 위한 모니터링 도구입니다. AI 에이전트는 LLM API 호출과 Tool Request를 반복하는 에이전트 루프로 작업을 처리합니다. 하지만 이 과정은 사용자에게 드러나지 않아서 에이전트가 각 단계에서 무엇을 했고 자원을 얼마나 썼는지 알기 어렵습니다.

이 프로젝트는 에이전트 루프 안에서 일어나는 LLM API 호출과 Tool Request를 추적합니다. 이 과정에서 토큰 사용량과 작업 시간 같은 metric을 수집하고, 수집한 데이터를 루프 단위로 시각화합니다. 이를 통해 AI 에이전트를 사용하는 개발자는 에이전트의 동작 과정과 자원 사용량을 구체적으로 확인할 수 있습니다.

## Features

- **에이전틱 루프 모니터링**: AI 에이전트가 작업 중에 반복하는 LLM API 호출과 Tool Request를 추적해 에이전트 루프가 실제로 어떻게 진행되는지 보여줍니다.
- **Metric 수집**: 에이전트 작업 중에 발생하는 토큰 사용량, 작업 시간 등의 metric을 수집합니다.
- **루프별 시각화**: 각 루프에서 수행한 작업 내용과 토큰 소모량 등을 시각화해 루프 단위로 에이전트의 동작과 자원 사용을 비교할 수 있게 합니다.

## Usage

[Bun](https://bun.sh)이 필요합니다. 의존성을 설치하고 빌드한 뒤 실행합니다.

```bash
bun install
bun run build
bun run install-plugins
bun run start
```

`bun run build`는 지금 플랫폼의 실행 파일 `dist/agentoscope`와 Plugin `dist/plugins/<에이전트 id>.js`를 만듭니다. `bun run start`는 빌드한 `dist/agentoscope`를 `run` 명령으로 실행해 Main Server와 Client Adapter Daemon을 구동합니다. `SIGINT`(Ctrl+C)나 `SIGTERM`을 받으면 종료합니다. 설정 파일을 지정하려면 `--` 뒤에 넘깁니다.

```bash
bun run start -- --config ./config.toml
```

Daemon은 설정의 Plugin 디렉터리(기본값 `~/.local/share/agentoscope/plugins`)에서 Plugin을 불러오며, Plugin이 없으면 아무것도 수집하지 않습니다. `bun run install-plugins`는 빌드한 `dist/plugins/`의 Plugin을 이 디렉터리에 설치합니다. Plugin 하나만 설치하려면 Plugin별 스크립트 `bun run install-plugin:<에이전트 id>`(예: `bun run install-plugin:opencode`)를 쓰거나 에이전트 id를 넘기고(`bun run install-plugins -- opencode`), 설정 파일을 쓰면 `--config`로 같은 파일을 넘겨 그 파일의 `plugin_directory`에 설치합니다. Plugin을 다시 빌드했으면 다시 설치하고 agentoscope를 다시 시작하세요. 설정 항목은 [Client Adapter Daemon 구현](docs/002.implementation/007.CLIENT_ADAPTER_DAEMON.md#설정)과 [Data Storage](docs/002.implementation/008.DATA_STORAGE.md#설정)를 참고하세요.
