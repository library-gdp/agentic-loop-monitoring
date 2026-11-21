/**
 * 실행 파일의 설정입니다. 설정 파일은 TOML이며(docs/002.implementation/001.TECH_STACK.md),
 * Main Server의 설정 항목은 docs/002.implementation/008.DATA_STORAGE.md를 따릅니다.
 */

import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface MainServerConfig {
    /** SQLite 데이터베이스 파일의 경로입니다. */
    readonly dataFile: string;
    /** 쓰기 잠금을 기다리는 최대 시간(밀리초)입니다. */
    readonly busyTimeoutMs: number;
}

/** Client Adapter Daemon의 설정입니다(docs/002.implementation/007.CLIENT_ADAPTER_DAEMON.md). */
export interface DaemonConfig {
    /** Daemon이 쓰는 파일(로그, 잠금 파일, Plugin의 상태)을 두는 디렉터리입니다. */
    readonly stateDirectory: string;
    /** 빌드한 Plugin을 두는 디렉터리입니다. */
    readonly pluginDirectory: string;
    /** 시작할 Plugin의 에이전트 id입니다. 설정하지 않으면 Plugin 디렉터리의 Plugin을 모두 시작합니다. */
    readonly plugins?: readonly string[];
    /** Transport입니다. 지금은 프로세스 내 호출만 지원합니다. */
    readonly transport: "in-process";
    /** Ack를 기다리는 최대 시간(밀리초)입니다. */
    readonly ackTimeoutMs: number;
    /** 재시도 가능한 실패 뒤 같은 Transport Unit을 다시 보내는 횟수입니다. */
    readonly retryCount: number;
    /** 첫 재시도 전에 기다리는 시간(밀리초)입니다. 재시도할 때마다 두 배로 늘립니다. */
    readonly retryIntervalMs: number;
}

/** Visualization의 설정입니다(docs/002.implementation/011.VISUALIZATION.md의 접속). */
export interface VisualizationConfig {
    /** 127.0.0.1에 바인딩할 포트입니다. 0이면 운영체제가 빈 포트를 고릅니다. */
    readonly port: number;
}

export interface Config {
    /** 읽은 설정 파일의 경로입니다. 기본 위치에 파일이 없어 기본값만 쓰면 비웁니다. */
    readonly path?: string;
    readonly mainServer: MainServerConfig;
    readonly daemon: DaemonConfig;
    readonly visualization: VisualizationConfig;
}

/** 설정 파일을 읽을 수 없거나 값이 잘못되었을 때 던집니다. */
export class ConfigError extends Error {
    override readonly name = "ConfigError";
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
export const DEFAULT_ACK_TIMEOUT_MS = 30_000;
export const DEFAULT_RETRY_COUNT = 5;
export const DEFAULT_RETRY_INTERVAL_MS = 1000;
export const DEFAULT_VISUALIZATION_PORT = 0;

export interface LoadConfigOptions {
    /** --config로 받은 설정 파일의 경로입니다. 주면 파일이 꼭 있어야 합니다. */
    readonly path?: string;
    /** 환경 변수입니다. 기본값은 process.env입니다. */
    readonly env?: Readonly<Record<string, string | undefined>>;
}

/** 환경 변수가 가리키는 디렉터리입니다. 환경 변수가 없거나 절대 경로가 아니면 홈 디렉터리 아래의 기본 위치를 씁니다. */
function envDirectory(
    env: Readonly<Record<string, string | undefined>>,
    name: "XDG_CONFIG_HOME" | "AGENTOSCOPE_HOME",
    fallback: string,
): string {
    const value = env[name];
    if (value !== undefined && isAbsolute(value)) return value;
    return join(env.HOME || homedir(), fallback);
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<Config> {
    const env = options.env ?? process.env;
    const path = resolve(
        options.path ??
            join(envDirectory(env, "XDG_CONFIG_HOME", ".config"), "agentoscope", "config.toml"),
    );
    const file = Bun.file(path);
    let document: Record<string, unknown> = {};
    const exists = await file.exists();
    if (exists) {
        try {
            document = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
        } catch (error) {
            throw new ConfigError(`cannot parse ${path}: ${(error as Error).message}`);
        }
    } else if (options.path !== undefined) {
        throw new ConfigError(`config file not found: ${path}`);
    }

    const where = (key: string) => `${key} in ${path}`;
    checkKeys(document, ["main_server", "daemon", "visualization"], where("the top level"));
    const mainServer = table(document, "main_server", where);
    checkKeys(mainServer, ["data_file", "busy_timeout_ms"], where("[main_server]"));
    const daemon = table(document, "daemon", where);
    checkKeys(
        daemon,
        [
            "state_directory",
            "plugin_directory",
            "plugins",
            "transport",
            "ack_timeout_ms",
            "retry_count",
            "retry_interval_ms",
        ],
        where("[daemon]"),
    );

    const visualization = table(document, "visualization", where);
    checkKeys(visualization, ["port"], where("[visualization]"));
    const port = integer(
        visualization,
        "port",
        DEFAULT_VISUALIZATION_PORT,
        0,
        where("visualization.port"),
    );
    if (port > 65_535)
        throw new ConfigError(`${where("visualization.port")} must be at most 65535`);

    const dataFile = optionalPath(mainServer, "data_file", where("main_server.data_file"));
    const busyTimeoutMs = integer(
        mainServer,
        "busy_timeout_ms",
        DEFAULT_BUSY_TIMEOUT_MS,
        1,
        where("main_server.busy_timeout_ms"),
    );
    const ackTimeoutMs = integer(
        daemon,
        "ack_timeout_ms",
        DEFAULT_ACK_TIMEOUT_MS,
        1,
        where("daemon.ack_timeout_ms"),
    );
    if (ackTimeoutMs <= busyTimeoutMs) {
        throw new ConfigError(
            `${where("daemon.ack_timeout_ms")} must be longer than main_server.busy_timeout_ms`,
        );
    }
    const transport = daemon.transport ?? "in-process";
    if (transport !== "in-process") {
        throw new ConfigError(`${where("daemon.transport")} must be "in-process"`);
    }
    const plugins = daemon.plugins;
    if (
        plugins !== undefined &&
        (!Array.isArray(plugins) ||
            !plugins.every((agent) => typeof agent === "string" && AGENT_ID.test(agent)))
    ) {
        throw new ConfigError(
            `${where("daemon.plugins")} must be a list of agent ids (lowercase letters and hyphens)`,
        );
    }

    // 상대 경로는 설정 파일이 있는 디렉터리를 기준으로 합니다.
    const configDirectory = dirname(path);
    const home = join(
        envDirectory(env, "AGENTOSCOPE_HOME", join(".local", "share")),
        "agentoscope",
    );
    const resolvePath = (value: string | undefined, fallback: string) =>
        value === undefined ? fallback : resolve(configDirectory, value);
    return {
        ...(exists ? { path } : {}),
        mainServer: {
            dataFile: resolvePath(dataFile, join(home, "agentoscope.db")),
            busyTimeoutMs,
        },
        daemon: {
            stateDirectory: resolvePath(
                optionalPath(daemon, "state_directory", where("daemon.state_directory")),
                join(home, "daemon"),
            ),
            pluginDirectory: resolvePath(
                optionalPath(daemon, "plugin_directory", where("daemon.plugin_directory")),
                join(home, "plugins"),
            ),
            ...(plugins === undefined ? {} : { plugins: plugins as string[] }),
            transport,
            ackTimeoutMs,
            retryCount: integer(
                daemon,
                "retry_count",
                DEFAULT_RETRY_COUNT,
                0,
                where("daemon.retry_count"),
            ),
            retryIntervalMs: integer(
                daemon,
                "retry_interval_ms",
                DEFAULT_RETRY_INTERVAL_MS,
                1,
                where("daemon.retry_interval_ms"),
            ),
        },
        visualization: { port },
    };
}

/** 에이전트 id 형식입니다(docs/001.model/005.PLUGIN_SPEC.md). */
const AGENT_ID = /^[a-z]+(?:-[a-z]+)*$/;

function table(
    document: Record<string, unknown>,
    name: string,
    where: (key: string) => string,
): Record<string, unknown> {
    const section = document[name] ?? {};
    if (typeof section !== "object" || section === null || Array.isArray(section)) {
        throw new ConfigError(`${where(name)} must be a table`);
    }
    return section as Record<string, unknown>;
}

function optionalPath(
    section: Record<string, unknown>,
    key: string,
    where: string,
): string | undefined {
    const value = section[key];
    if (value !== undefined && (typeof value !== "string" || value === "")) {
        throw new ConfigError(`${where} must be a non-empty string`);
    }
    return value;
}

function integer(
    section: Record<string, unknown>,
    key: string,
    fallback: number,
    minimum: number,
    where: string,
): number {
    const value = section[key] ?? fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
        throw new ConfigError(
            `${where} must be ${minimum > 0 ? "a positive" : "a non-negative"} integer`,
        );
    }
    return value;
}

function checkKeys(table: Record<string, unknown>, known: readonly string[], where: string): void {
    for (const key of Object.keys(table)) {
        if (!known.includes(key)) throw new ConfigError(`unknown key "${key}" at ${where}`);
    }
}
