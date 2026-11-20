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

export interface Config {
    /** 읽은 설정 파일의 경로입니다. 기본 위치에 파일이 없어 기본값만 쓰면 비웁니다. */
    readonly path?: string;
    readonly mainServer: MainServerConfig;
}

/** 설정 파일을 읽을 수 없거나 값이 잘못되었을 때 던집니다. */
export class ConfigError extends Error {
    override readonly name = "ConfigError";
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export interface LoadConfigOptions {
    /** --config로 받은 설정 파일의 경로입니다. 주면 파일이 꼭 있어야 합니다. */
    readonly path?: string;
    /** 환경 변수입니다. 기본값은 process.env입니다. */
    readonly env?: Readonly<Record<string, string | undefined>>;
}

/** XDG Base Directory의 디렉터리입니다. 환경 변수가 없거나 비어 있으면 기본 위치를 씁니다. */
function xdgDirectory(
    env: Readonly<Record<string, string | undefined>>,
    name: "XDG_CONFIG_HOME" | "XDG_DATA_HOME",
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
            join(xdgDirectory(env, "XDG_CONFIG_HOME", ".config"), "agentoscope", "config.toml"),
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
    checkKeys(document, ["main_server"], where("the top level"));
    const section = document.main_server ?? {};
    if (typeof section !== "object" || section === null || Array.isArray(section)) {
        throw new ConfigError(`${where("main_server")} must be a table`);
    }
    const mainServer = section as Record<string, unknown>;
    checkKeys(mainServer, ["data_file", "busy_timeout_ms"], where("[main_server]"));

    const dataFile = mainServer.data_file;
    if (dataFile !== undefined && (typeof dataFile !== "string" || dataFile === "")) {
        throw new ConfigError(`${where("main_server.data_file")} must be a non-empty string`);
    }
    const busyTimeoutMs = mainServer.busy_timeout_ms ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (
        typeof busyTimeoutMs !== "number" ||
        !Number.isSafeInteger(busyTimeoutMs) ||
        busyTimeoutMs <= 0
    ) {
        throw new ConfigError(`${where("main_server.busy_timeout_ms")} must be a positive integer`);
    }

    return {
        ...(exists ? { path } : {}),
        mainServer: {
            // 상대 경로는 설정 파일이 있는 디렉터리를 기준으로 합니다.
            dataFile:
                dataFile === undefined
                    ? join(
                          xdgDirectory(env, "XDG_DATA_HOME", join(".local", "share")),
                          "agentoscope",
                          "agentoscope.db",
                      )
                    : resolve(dirname(path), dataFile),
            busyTimeoutMs,
        },
    };
}

function checkKeys(table: Record<string, unknown>, known: readonly string[], where: string): void {
    for (const key of Object.keys(table)) {
        if (!known.includes(key)) throw new ConfigError(`unknown key "${key}" at ${where}`);
    }
}
