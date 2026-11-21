/**
 * agentoscope 실행 파일의 진입점입니다. Main Server와 Client Adapter Daemon을 한 프로세스로 구동하며,
 * Daemon은 Main Server에 프로세스 내 호출로 Transport Unit을 보냅니다
 * (docs/002.implementation/001.TECH_STACK.md의 실행 구성).
 */

import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Logger } from "@agentoscope/core";
import { type Daemon, DaemonAlreadyRunningError, startDaemon } from "@agentoscope/daemon";
import rootPackage from "../../../package.json" with { type: "json" };
import { type Config, ConfigError, loadConfig } from "./config";
import { createJsonLinesLogger } from "./logger";
import { type MainServer, openMainServer } from "./main-server";

const USAGE = `Usage: agentoscope <command> [--config <path>]

Commands:
  run       Run the Main Server and the Client Adapter Daemon until SIGINT or SIGTERM
  version   Print the version
  help      Print this help

Options:
  --config <path>   Config file (default: $XDG_CONFIG_HOME/agentoscope/config.toml)
`;

export interface CommandIo {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
    /** Main Server의 로그입니다. */
    readonly logger: Logger;
    /** Daemon의 로그입니다. Daemon은 상태 디렉터리의 자신의 로그 파일에만 기록합니다. */
    readonly daemonLogger: (stateDirectory: string) => Logger;
    /** 종료 신호를 받을 때까지 기다립니다. */
    readonly waitForSignal: () => Promise<string>;
}

/** 상태 디렉터리 안의 Daemon 로그 파일 이름입니다. */
export const DAEMON_LOG_FILE = "daemon.log";
/** 재시도 간격의 상한(밀리초)입니다. */
const MAX_RETRY_INTERVAL_MS = 60_000;

const processIo: CommandIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    logger: createJsonLinesLogger(),
    daemonLogger: (stateDirectory) => {
        mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
        chmodSync(stateDirectory, 0o700);
        const path = join(stateDirectory, DAEMON_LOG_FILE);
        return createJsonLinesLogger((line) => appendFileSync(path, line, { mode: 0o600 }));
    },
    waitForSignal: () =>
        new Promise((resolve) => {
            for (const signal of ["SIGINT", "SIGTERM"] as const) {
                process.once(signal, () => resolve(signal));
            }
        }),
};

/** 명령을 실행하고 종료 코드를 돌려줍니다. */
export async function main(args: readonly string[], io: CommandIo = processIo): Promise<number> {
    let parsed: ReturnType<typeof parseCommandLine>;
    try {
        parsed = parseCommandLine(args);
    } catch (error) {
        io.stderr(`${(error as Error).message}\n\n${USAGE}`);
        return 2;
    }
    const [command = "help", ...extra] = parsed.positionals;
    if (extra.length > 0) {
        io.stderr(`unexpected arguments: ${extra.join(" ")}\n\n${USAGE}`);
        return 2;
    }
    switch (command) {
        case "run":
            return run(parsed.values.config, io);
        case "version":
            io.stdout(`${rootPackage.version}\n`);
            return 0;
        case "help":
            io.stdout(USAGE);
            return 0;
        default:
            io.stderr(`unknown command: ${command}\n\n${USAGE}`);
            return 2;
    }
}

function parseCommandLine(args: readonly string[]) {
    return parseArgs({
        args: [...args],
        options: { config: { type: "string" } },
        allowPositionals: true,
        strict: true,
    });
}

async function run(configPath: string | undefined, io: CommandIo): Promise<number> {
    const { logger } = io;
    // 시작하는 동안 받은 종료 신호도 놓치지 않도록 먼저 기다리기 시작합니다.
    const signal = io.waitForSignal();
    let server: MainServer;
    let config: Config;
    try {
        config = await loadConfig(configPath === undefined ? {} : { path: configPath });
        server = openMainServer({ ...config.mainServer, logger });
        logger.info("main server started", {
            config: config.path ?? null,
            dataFile: config.mainServer.dataFile,
            version: rootPackage.version,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(error instanceof ConfigError ? "invalid config" : "cannot start", {
            message,
        });
        return 1;
    }

    let daemon: Daemon | undefined;
    try {
        const prepared = server.prepare().then(
            () => ({ ready: true }) as const,
            (error: unknown) => ({ ready: false, error }) as const,
        );
        const first = await Promise.race([signal.then((name) => ({ signal: name })), prepared]);
        if (!("ready" in first)) {
            logger.info("main server is stopping", { signal: first.signal });
            return 0;
        }
        if (!first.ready) {
            logger.error("cannot prepare derived data", { message: String(first.error) });
            return 1;
        }
        logger.info("main server is ready");

        // Main Server가 Transport Unit을 받을 수 있게 된 뒤에 Daemon을 시작합니다.
        const { daemon: settings } = config;
        try {
            daemon = await startDaemon({
                stateDirectory: settings.stateDirectory,
                pluginDirectory: settings.pluginDirectory,
                ...(settings.plugins === undefined ? {} : { plugins: settings.plugins }),
                transport: server.receive,
                ackTimeoutMs: settings.ackTimeoutMs,
                retry: {
                    count: settings.retryCount,
                    intervalMs: settings.retryIntervalMs,
                    maxIntervalMs: Math.max(settings.retryIntervalMs, MAX_RETRY_INTERVAL_MS),
                },
                host: hostname(),
                logger: io.daemonLogger(settings.stateDirectory),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(
                error instanceof DaemonAlreadyRunningError
                    ? "another daemon is running"
                    : "cannot start the daemon",
                { message, stateDirectory: settings.stateDirectory },
            );
            return 1;
        }
        logger.info("daemon started", {
            stateDirectory: settings.stateDirectory,
            pluginDirectory: settings.pluginDirectory,
            plugins: [...daemon.started],
        });
        logger.info("main server is stopping", { signal: await signal });
        return 0;
    } finally {
        // Daemon이 남은 Transport Unit을 보낸 뒤에 Main Server를 닫습니다.
        await daemon?.stop();
        server.close();
    }
}

if (import.meta.main) {
    // Plugin 안에서 처리하지 못한 오류로 프로세스가 끝나지 않게 합니다(Fail-open).
    process.on("unhandledRejection", (reason) => {
        processIo.logger.error("unhandled rejection", { message: String(reason) });
    });
    process.exit(await main(process.argv.slice(2)));
}
