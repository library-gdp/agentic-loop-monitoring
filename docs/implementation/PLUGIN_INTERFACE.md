# PLUGIN_INTERFACE.md

이 문서는 Plugin이 구현하고 Client Adapter Daemon(이하 Daemon)이 부르는 TypeScript 인터페이스를 정합니다. Plugin의 역할과 규칙은 [Plugin Specification](../model/PLUGIN_SPEC.md)을, Session Log Event의 필드는 [Domain Model](../model/DOMAIN_MODEL.md#session-log-event)을 따르며, 이 문서는 바꾸지 않습니다. 이 타입을 담은 패키지를 Plugin과 Daemon이 어떻게 가져다 쓰는지는 [Plugin Guide](PLUGIN_GUIDE.md#plugin을-daemon에-넣는-방식)를 참고하세요. 용어는 [Glossary](../model/GLOSSARY.md)를 따릅니다.

아래 타입은 모두 Plugin API 패키지에 둡니다. Daemon과 모든 Plugin은 이 타입만 참조합니다.

## Plugin

Plugin 패키지는 아래 `Plugin`을 구현한 객체 하나를 내보냅니다.

```ts
export interface Plugin {
  /** 에이전트 id입니다(예: "claude-code"). Batch의 source.agent에 담깁니다. */
  readonly agent: string;
  /** Plugin의 버전입니다. Batch의 source.plugin_version에 담깁니다. */
  readonly version: string;
  /** Trigger를 설정하고 수집을 시작합니다. */
  start(context: PluginContext): Promise<void>;
  /** Trigger를 해제하고 진행 중인 수집을 멈춥니다. */
  stop(): Promise<void>;
}
```

- `agent`는 [Plugin Specification의 에이전트 id](../model/PLUGIN_SPEC.md#에이전트-id)입니다. Session 안의 Agent를 식별하는 Agent ID와 다릅니다.
- `version`은 Plugin 패키지의 버전과 같은 값입니다.

### 시작과 종료

| 시점 | Daemon | Plugin |
|---|---|---|
| Daemon 시작 | 설정의 "사용할 Plugin"에 있는 Plugin마다 `start`를 한 번 부릅니다. Plugin마다 다른 `PluginContext`를 넘깁니다. | Trigger를 설정한 뒤 `start`를 끝냅니다. 수집은 `start`가 끝난 뒤에도 Trigger에 따라 계속합니다. |
| `start` 실패 | 로그를 남기고 그 Plugin을 시작하지 않은 것으로 봅니다. 다른 Plugin은 그대로 시작합니다. | |
| Daemon 종료 | 시작한 Plugin마다 `stop`을 부릅니다. | Trigger를 해제하고 진행 중인 수집을 멈춘 뒤 `stop`을 끝냅니다. `stop`이 끝난 뒤에는 `submit`을 부르지 않습니다. |

- 설정에서 활성화하지 않은 Plugin은 `start`가 불리지 않으므로 Session Log를 수집하지 않습니다.
- `start`가 끝난 뒤 Plugin 안에서 일어난 오류는 Plugin이 처리합니다. Plugin은 자신의 오류로 Daemon 프로세스를 끝내지 않습니다.

## PluginContext

Daemon이 `start`에 넘기는 값입니다. Plugin이 Daemon에 접근하는 방법은 이것뿐입니다.

```ts
export interface PluginContext {
  /** Batch 하나를 Daemon에 넘깁니다. */
  submit(batch: PluginBatch): void;
  /** Daemon의 로그 파일에 기록합니다. */
  readonly logger: PluginLogger;
}

export interface PluginLogger {
  info(message: string, details?: Readonly<Record<string, JsonValue>>): void;
  warn(message: string, details?: Readonly<Record<string, JsonValue>>): void;
  error(message: string, details?: Readonly<Record<string, JsonValue>>): void;
}
```

### `submit`

- Plugin은 [Batch 단위](../model/PLUGIN_SPEC.md#batch-단위)로 묶은 Session Log Event를 `submit` 한 번에 하나씩 넘깁니다. Daemon은 넘겨받은 `PluginBatch` 하나를 Batch 하나로 보냅니다.
- `submit`은 Batch를 Daemon의 전송 대기열에 넣고 바로 돌아옵니다. 전송 결과를 Plugin에 돌려주지 않으며, 재시도는 Daemon이 맡습니다([Client Adapter Daemon](../model/CLIENT_ADAPTER_DAEMON.md#ack-처리) 참고).
- Daemon은 여러 Plugin이 넘긴 Batch를 `submit`이 불린 순서대로 보냅니다.
- Daemon은 `PluginBatch`를 합치거나, 나누거나, Batch 규칙을 다시 확인하지 않습니다. 규칙은 Plugin이 지킵니다.
- Plugin은 `submit`에 넘긴 객체를 그 뒤에 바꾸지 않습니다.

### `logger`

Daemon은 자신의 로그 파일에만 기록합니다([Client Adapter Daemon](../model/CLIENT_ADAPTER_DAEMON.md#로그) 참고). Plugin은 표준 출력, 표준 오류나 자신의 로그 파일에 쓰지 않고 `logger`에 기록합니다. Daemon은 Plugin이 남긴 로그에 그 Plugin의 에이전트 id를 붙입니다.

| 경우 | 수준 |
|---|---|
| 완결되었지만 해석할 수 없는 레코드를 건너뛴 경우 | `warn` |
| 사용자가 중단한 Turn을 버린 경우 | `info` |

## PluginBatch

Plugin이 `submit`에 넘기는 Batch입니다. [Agent Logging Protocol의 Batch](../model/AGENT_LOGGING_PROTOCOL.md#batch)에서 Daemon이 채우는 `protocol_version`, `batch_id`, `source`를 뺀 것입니다. 필드 이름은 Batch의 필드 이름을 그대로 쓰므로, Daemon은 이 객체에 세 필드를 더해 그대로 직렬화합니다.

```ts
export interface PluginBatch {
  readonly session: {
    /** Session ID입니다. Main Agent와 Subagent가 같은 값을 씁니다. */
    readonly id: string;
    /** 에이전트의 작업 디렉터리입니다. 알 수 없으면 뺍니다. */
    readonly cwd?: string;
  };
  readonly agent: {
    /** events를 기록한 Agent의 Agent ID입니다. */
    readonly id: string;
    /** 부모 Agent ID입니다. Main Agent이면 뺍니다. */
    readonly parent_id?: string;
  };
  /** Session Log에 기록된 순서를 따르며, 항상 user_message로 시작합니다. */
  readonly events: readonly [UserMessageEvent, ...SessionLogEvent[]];
}
```

## Session Log Event

[Domain Model의 Session Log Event](../model/DOMAIN_MODEL.md#session-log-event)를 그대로 옮긴 타입입니다. Domain Model에 Session Log Event 종류나 필드가 더해지면 이 타입에도 더합니다.

```ts
/** RFC 3339 형식의 시각입니다. 시간대를 포함합니다. */
export type Timestamp = string;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type SessionLogEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolResultEvent;

interface SessionLogEventBase {
  readonly event_id: string;
  readonly timestamp: Timestamp;
}

export interface UserMessageEvent extends SessionLogEventBase {
  readonly type: "user_message";
  readonly text: string;
}

export interface AssistantMessageEvent extends SessionLogEventBase {
  readonly type: "assistant_message";
  readonly model?: string;
  readonly content: readonly ContentBlock[];
  readonly usage?: TokenUsage;
  readonly started_at?: Timestamp;
}

export type ContentBlock = TextBlock | ReasoningBlock | ToolUseBlock;

export interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface ReasoningBlock {
  readonly type: "reasoning";
  readonly text: string;
}

export interface ToolUseBlock {
  readonly type: "tool_use";
  readonly tool_use_id: string;
  readonly name: string;
  readonly input: JsonObject;
}

export interface ToolResultEvent extends SessionLogEventBase {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly output: string | JsonObject;
  readonly is_error?: boolean;
}

export interface TokenUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_tokens?: number;
  readonly cache_write_tokens?: number;
  readonly reasoning_tokens?: number;
}
```

- **없는 값은 속성을 뺍니다.** 에이전트가 기록하지 않은 값은 속성을 두지 않으며, `undefined`나 `null`, `0`을 넣지 않습니다([Plugin Specification](../model/PLUGIN_SPEC.md#수집-방식) 참고).
- **시각은 에이전트가 기록한 값으로 만듭니다.** `Date`로 바꾸지 않고 RFC 3339 string으로 넘깁니다. 에이전트가 기록한 형식이 RFC 3339가 아니면 Plugin이 RFC 3339로 바꿉니다.
- **`TokenUsage`의 값은 0 이상의 정수입니다.**

## 결정되지 않은 사항

- Plugin이 수집한 위치 같은 자신의 상태를 저장하는 위치와, 그 위치를 `PluginContext`로 넘길지 여부
- `stop`이 끝나기를 Daemon이 기다리는 최대 시간
