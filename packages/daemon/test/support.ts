import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext, PluginTransportUnit } from "@agentoscope/plugin-api";
import type { Logger } from "../src";

const directories: string[] = [];

export function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "agentoscope-daemon-"));
    directories.push(directory);
    return directory;
}

export function cleanUp(): void {
    for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
}

export interface Log {
    readonly level: "info" | "warn" | "error";
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
}

export function recordingLogger(logs: Log[]): Logger {
    const log =
        (level: Log["level"]) => (message: string, details?: Readonly<Record<string, unknown>>) => {
            logs.push({ level, message, ...(details === undefined ? {} : { details }) });
        };
    return { info: log("info"), warn: log("warn"), error: log("error") };
}

export function pluginUnit(turn: string, position = 0): PluginTransportUnit {
    return {
        session: { id: "ses_1", cwd: "/work" },
        agent: { id: "ses_1" },
        turn: { id: turn, position },
        events: [
            {
                event_id: `${turn}:${position}`,
                type: "turn_interrupted",
                timestamp: "2026-11-21T00:00:00Z",
            },
        ],
    };
}

/** Plugin 디렉터리에 빌드한 Plugin 모듈처럼 쓴 .js 파일을 둡니다. */
export function writePlugin(directory: string, name: string, source: string): void {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, name), source);
}

/**
 * submit을 부르는 시험용 Plugin 모듈의 소스입니다. start가 불리면 globalThis.__plugins[agent]에 context를 둡니다.
 */
export function testPluginSource(agent: string, options: { failStart?: boolean } = {}): string {
    return `
export const apiVersion = 1;
export function register(registry) {
    registry.register({
        agent: ${JSON.stringify(agent)},
        version: "9.9.9",
        async start(context) {
            ${options.failStart ? 'throw new Error("cannot start");' : ""}
            globalThis.__plugins ??= {};
            globalThis.__plugins[${JSON.stringify(agent)}] = { context, stopped: false };
        },
        async stop() {
            globalThis.__plugins[${JSON.stringify(agent)}].stopped = true;
        },
    });
}
`;
}

/** 시험용 Plugin 모듈이 start에서 받은 context입니다. 모듈과 테스트가 globalThis로 주고받습니다. */
export interface StartedPlugin {
    readonly context: PluginContext;
    readonly stopped: boolean;
}

const shared = globalThis as { __plugins?: Record<string, StartedPlugin> };

export function startedPlugin(agent: string): StartedPlugin | undefined {
    return shared.__plugins?.[agent];
}

export function forgetStartedPlugins(): void {
    delete shared.__plugins;
}
