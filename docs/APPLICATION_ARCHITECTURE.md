# APPLICATION_ARCHITECTURE.md

이 문서는 애플리케이션 아키텍처에 대해서 설명합니다. 이 애플리케이션의 목적은 Codex, Claude Code, Open Code 등 AI 에이전트의 작업을 모니터링하고 LLM에 어떤 input과 output이 있었는지, 토큰 사용량은 얼마나 되는지, 한 번의 LLM reasoning에 대해 어떤 도구가 호출이 되었는지 등을 기록하고 나중에 시각화 합니다.

이 애플리케이션은 AI 에이전트로부터 이벤트를 수집합니다.

## Module Description

이 애플리케이션이 어떤 모듈로 이루어졌는지를 설명합니다.

```
                 ┌──────────────────────┐
AI 에이전트 ───▶ │    Input Adapter     │
                 └──────────┬───────────┘
                            │ Ingest API
                            ▼
                 ┌──────────────────────┐   Query API   ┌───────────────┐
                 │         Core         │ ◀──────────── │ Visualization │
                 └──────────▲───────────┘               └───────────────┘
                            │ Repository API (구현)
                 ┌──────────┴───────────┐
                 │     Persistence      │
                 └──────────────────────┘
```

화살표는 의존 방향입니다. 모든 모듈은 Core에 의존하며, Core는 다른 어떤 모듈에도 의존하지 않습니다.

### Core

애플리케이션의 본질과 수행하는 기능, 애플리케이션의 의미, 추상적인 high-level 로직을 나타냅니다. 데이터의 흐름과 도메인 로직을 처리합니다.

Core 모듈은 다음을 정의합니다.

- **엔티티와 데이터 구조**: 애플리케이션의 추상화된 도메인 모델 객체를 정의합니다. 에이전트 종류와 무관한 공통 이벤트 모델인 Canonical Event도 Core에서 선언합니다.
- **API**: 다른 모듈과 메시지를 교환하기 위한 API를 정의합니다.
  - **Ingest API**: Input Adapter가 Canonical Event를 Core에 전달하기 위한 API입니다.
  - **Query API**: Visualization이 기록된 데이터를 조회하기 위한 API입니다.
  - **Repository API**: 데이터 영속화를 위한 API입니다. Core가 정의하고 Persistence가 구현합니다.

### Input Adapter

애플리케이션의 entrypoint입니다. AI 에이전트로부터 이벤트를 수집하고, Claude Code, Codex, Open Code 등 여러 데이터 소스로부터 오는 서로 형태가 다른 데이터를 Canonical Event로 변환하여 Core의 Ingest API로 전달합니다.

Input Adapter는 두 가지 관심사로 나뉩니다.

- **Transport**: 이벤트를 주고받는 방식을 다룹니다. 표준입출력, Unix Socket, REST API, Streamable HTTP, WebSocket 등을 지원합니다.
- **Translator**: 에이전트별 데이터를 deserialization하고 Canonical Event로 변환합니다. 에이전트마다 하나의 Translator를 둡니다.

#### 수집 경로

이벤트는 hook과 세션 로그 파일, 두 경로로 수집합니다.

1. 에이전트가 hook을 호출하면 hook 클라이언트가 실행됩니다.
2. hook 클라이언트는 전달받은 이벤트를 데몬에 넘기고 바로 종료합니다.
3. 에이전트가 Stop hook을 호출하면 데몬은 해당 세션의 세션 로그 파일을 읽어들입니다.
4. 데몬은 읽어들인 데이터를 Translator를 통해 Canonical Event로 변환하여 Core에 전달합니다.

hook 클라이언트는 에이전트가 호출할 때마다 실행되었다가 종료되는 프로세스이고, 데몬은 계속 실행되면서 이벤트를 처리하는 프로세스입니다.

### Persistence

데이터의 영속화를 책임지는 모듈입니다. Core가 정의한 Repository API를 구현합니다. 데이터의 흐름과 로직을 정의하지 않습니다. 데이터가 저장되는 방식만 다룹니다.

### Visualization

모니터링한 내용을 시각화하는 역할을 수행합니다. 데이터는 Core의 Query API를 통해서만 조회하며, Persistence에 직접 접근하지 않습니다.

## Principles

### Observe-only

이 애플리케이션은 AI 에이전트의 작업을 관찰만 합니다. 에이전트의 동작을 차단하거나 수정하지 않으며, 에이전트의 컨텍스트에 어떠한 내용도 주입하지 않습니다.

### Fail-open

에이전트의 작업이 이 애플리케이션 때문에 멈추어서는 안 됩니다.

- hook 클라이언트는 에이전트로부터 input을 받으면 항상 **빈 출력과 exit code 0**으로 즉시 종료합니다.
- 데몬이 실행 중이지 않거나 이벤트 전달에 실패하더라도 hook 클라이언트는 동일하게 빈 출력과 exit code 0으로 종료합니다.
- 세션 기록 데이터 처리는 데몬에서 비동기로 수행합니다.
- 이벤트 유실을 허용합니다.

### Masking

보안 및 개인정보 마스킹은 수행하지 않습니다.

## Philosophy

각 모듈은 그 모듈에게 주어진 역할을 specification에 맞게 정확히 수행해야 합니다. 다만 각 모듈의 API와 implementation은 엄격히 분리되고 implementation은 API에 의존하되 API는 implementation에 의존해서는 안 됩니다. 그리고 모듈 간 메시지 교환은 API를 통해서 이루어져야 합니다. 이를 통해 애플리케이션의 재사용성, 확장성을 확보하고 모듈 교체가 원활히 이루어질 수 있어야 합니다.
