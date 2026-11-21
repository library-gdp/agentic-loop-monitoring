/**
 * agentoscope 실행 파일의 진입점입니다. 지금은 Main Server만 구동하며, Client Adapter Daemon은 같은 프로세스에
 * 나중에 더합니다(docs/002.implementation/001.TECH_STACK.md의 실행 구성).
 */

import { parseArgs } from "node:util";
import type { Logger } from "@agentoscope/core";
import rootPackage from "../../../package.json" with { type: "json" };
import { ConfigError, loadConfig } from "./config";
import { createJsonLinesLogger } from "./logger";
import { type MainServer, openMainServer } from "./main-server";

const USAGE = `Usage: agentoscope <command> [--config <path>]

Commands:
  run       Run the Main Server until SIGINT or SIGTERM
  version   Print the version
  help      Print this help

Options:
  --config <path>   Config file (default: $XDG_CONFIG_HOME/agentoscope/config.toml)
`;

export interface CommandIo {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
    readonly logger: Logger;
    /** 종료 신호를 받을 때까지 기다립니다. */
    readonly waitForSignal: () => Promise<string>;
}

const processIo: CommandIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    logger: createJsonLinesLogger(),
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
    try {
        const config = await loadConfig(configPath === undefined ? {} : { path: configPath });
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

    try {
        const prepared = server.prepare().then(
            () => ({ ready: true }) as const,
            (error: unknown) => ({ ready: false, error }) as const,
        );
        const first = await Promise.race([signal.then((name) => ({ signal: name })), prepared]);
        if ("ready" in first) {
            if (!first.ready) {
                logger.error("cannot prepare derived data", { message: String(first.error) });
                return 1;
            }
            logger.info("main server is ready");
            logger.info("main server is stopping", { signal: await signal });
        } else {
            logger.info("main server is stopping", { signal: first.signal });
        }
        return 0;
    } finally {
        server.close();
    }
}

if (import.meta.main) {
    process.exit(await main(process.argv.slice(2)));
}
