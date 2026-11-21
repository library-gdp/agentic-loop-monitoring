/**
 * Agent Logging Protocol 버전 1의 메시지입니다. docs/001.model/004.AGENT_LOGGING_PROTOCOL.md를
 * 따릅니다. Daemon, Plugin, Main Server가 같은 타입을 쓰도록 Plugin API 패키지에 둡니다.
 * 이 타입의 변경은 PLUGIN_API_VERSION이 아니라 Agent Logging Protocol의 버전 규칙을 따릅니다.
 */

import type { PluginTransportUnit } from "./plugin";

/** 이 패키지가 정의하는 Agent Logging Protocol의 버전입니다. */
export const PROTOCOL_VERSION = 1;

/** Daemon이 Main Server에 보내는 Transport Unit입니다. PluginTransportUnit에 Daemon이 채우는 필드를 더한 것입니다. */
export interface TransportUnit extends PluginTransportUnit {
    readonly protocol_version: number;
    readonly transport_unit_id: string;
    readonly source: {
        /** 에이전트 id입니다. */
        readonly agent: string;
        /** Session Log Event를 만든 Plugin의 버전입니다. */
        readonly plugin_version: string;
        /** Daemon이 실행 중인 머신의 이름입니다. */
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
    /** Transport Unit을 해석하지 못해 알 수 없으면 빈 문자열입니다. */
    readonly transport_unit_id: string;
    readonly status: "rejected";
    /** 같은 Transport Unit을 다시 보내면 성공할 수 있으면 true입니다. */
    readonly retryable: boolean;
    readonly error: {
        readonly code: AckErrorCode;
        readonly message?: string;
    };
}

/** Main Server가 Transport Unit을 처리한 결과입니다. */
export type Ack = AcceptedAck | RejectedAck;
