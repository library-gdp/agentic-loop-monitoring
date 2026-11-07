/** Agent Logging Protocol 버전 1의 메시지입니다. docs/001.model/004.AGENT_LOGGING_PROTOCOL.md를 따릅니다. */

import type { PluginTransportUnit } from "@alm/plugin-api";

export type {
  AssistantMessageEvent,
  CompactionEvent,
  CompactionSummaryEvent,
  ContentBlock,
  ContextMessageEvent,
  JsonObject,
  JsonValue,
  LlmCallError,
  SessionLogEvent,
  StopReason,
  TokenUsage,
  ToolResultEvent,
  ToolUseBlock,
  TurnInterruptedEvent,
  UserMessageEvent,
} from "@alm/plugin-api";

export const PROTOCOL_VERSION = 1;

export interface TransportUnit extends PluginTransportUnit {
  readonly protocol_version: number;
  readonly transport_unit_id: string;
  readonly source: {
    readonly agent: string;
    readonly plugin_version: string;
    readonly host?: string;
  };
}

export type AckErrorCode = "invalid_transport_unit" | "unsupported_version" | "unavailable";

export interface AcceptedAck {
  readonly protocol_version: number;
  readonly transport_unit_id: string;
  readonly status: "accepted";
}

export interface RejectedAck {
  readonly protocol_version: number;
  readonly transport_unit_id: string;
  readonly status: "rejected";
  readonly retryable: boolean;
  readonly error: { readonly code: AckErrorCode; readonly message?: string };
}

export type Ack = AcceptedAck | RejectedAck;
