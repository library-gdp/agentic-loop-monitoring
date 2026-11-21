/**
 * Plugin이 갖추고 Daemon이 불러 쓰는 인터페이스입니다.
 * docs/002.implementation/005.PLUGIN_INTERFACE.md를 그대로 옮겼습니다.
 */

import type { JsonValue, SessionLogEvent } from "./session-log-event";

/** Plugin API의 버전입니다. 이미 빌드한 Plugin이나 Daemon과 호환되지 않는 변경이 있을 때만 올립니다. */
export const PLUGIN_API_VERSION = 1;

export interface PluginModule {
    /** 이 모듈을 빌드할 때 쓴 Plugin API의 PLUGIN_API_VERSION입니다. */
    readonly apiVersion: number;
    /** Daemon이 부르면 registry에 자신의 Plugin을 등록합니다. */
    register(registry: PluginRegistry): void;
}

export interface PluginRegistry {
    /** Plugin을 Collection에 등록합니다. */
    register(plugin: Plugin): void;
}

export interface Plugin {
    /** 에이전트 id입니다(예: "claude-code"). Transport Unit의 source.agent에 담깁니다. */
    readonly agent: string;
    /** Plugin의 버전입니다. Transport Unit의 source.plugin_version에 담깁니다. */
    readonly version: string;
    /** Trigger를 설정하고 수집을 시작합니다. */
    start(context: PluginContext): Promise<void>;
    /** Trigger를 해제하고 진행 중인 수집을 멈춥니다. */
    stop(): Promise<void>;
}

export interface PluginContext {
    /** Transport Unit 하나를 Daemon에 넘깁니다. */
    submit(unit: PluginTransportUnit): void;
    /** Daemon의 로그 파일에 기록합니다. */
    readonly logger: PluginLogger;
    /**
     * 이 Plugin만 쓰는 상태 디렉터리의 절대 경로입니다. 수집한 위치 같은 Plugin 자신의 상태를 둡니다.
     * Daemon이 start를 부르기 전에 권한 0700으로 만들어 둡니다.
     */
    readonly stateDirectory: string;
}

export interface PluginLogger {
    info(message: string, details?: Readonly<Record<string, JsonValue>>): void;
    warn(message: string, details?: Readonly<Record<string, JsonValue>>): void;
    error(message: string, details?: Readonly<Record<string, JsonValue>>): void;
}

/**
 * Plugin이 submit에 넘기는 Transport Unit입니다. Agent Logging Protocol의 Transport Unit에서
 * Daemon이 채우는 protocol_version, transport_unit_id, source를 뺀 것입니다.
 */
export interface PluginTransportUnit {
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
    readonly turn: {
        /** events가 속한 Turn을 시작한 user_message의 event_id입니다. */
        readonly id: string;
        /** events의 첫 Session Log Event의 Turn 안 위치입니다. user_message가 0입니다. */
        readonly position: number;
    };
    /** 레코드 하나에서 나온 Session Log Event입니다. 레코드 안에서 나온 순서를 따릅니다. */
    readonly events: readonly [SessionLogEvent, ...SessionLogEvent[]];
}
