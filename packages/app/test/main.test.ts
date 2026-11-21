import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import rootPackage from "../../../package.json" with { type: "json" };
import { type CommandIo, main } from "../src/main";
import { cleanUp, type Log, recordingLogger, temporaryDirectory } from "./support";

afterEach(cleanUp);

const MAIN = join(import.meta.dir, "../src/main.ts");

interface Captured {
    readonly io: CommandIo;
    readonly out: string[];
    readonly err: string[];
    readonly logs: Log[];
    readonly daemonLogs: Log[];
}

/** 표준 출력, 표준 오류, 로그를 모읍니다. 종료 신호는 Main Server가 준비되면 보냅니다. */
function capture(): Captured {
    const out: string[] = [];
    const err: string[] = [];
    const logs: Log[] = [];
    let signal: (name: string) => void = () => {};
    const waiting = new Promise<string>((resolve) => {
        signal = resolve;
    });
    const logger = recordingLogger(logs);
    const daemonLogs: Log[] = [];
    return {
        io: {
            stdout: (text) => out.push(text),
            stderr: (text) => err.push(text),
            logger: {
                ...logger,
                info(message, details) {
                    logger.info(message, details);
                    if (message === "daemon started") signal("SIGTERM");
                },
            },
            daemonLogger: () => recordingLogger(daemonLogs),
            waitForSignal: () => waiting,
        },
        out,
        err,
        logs,
        daemonLogs,
    };
}

describe("main", () => {
    test("prints the version and the usage", async () => {
        const version = capture();
        expect(await main(["version"], version.io)).toBe(0);
        expect(version.out).toEqual([`${rootPackage.version}\n`]);

        for (const args of [[], ["help"]]) {
            const help = capture();
            expect(await main(args, help.io)).toBe(0);
            expect(help.out.join("")).toContain("Usage: agentoscope <command>");
        }
    });

    test("rejects unknown commands, options and extra arguments", async () => {
        for (const args of [["serve"], ["run", "--port", "1"], ["version", "extra"]]) {
            const captured = capture();
            expect(await main(args, captured.io)).toBe(2);
            expect(captured.err.join("")).toContain("Usage: agentoscope <command>");
        }
    });

    test("runs the Main Server and the Daemon until it receives a signal", async () => {
        const directory = temporaryDirectory();
        const config = join(directory, "config.toml");
        writeFileSync(
            config,
            '[main_server]\ndata_file = "data/agentoscope.db"\n' +
                '[daemon]\nstate_directory = "state"\nplugin_directory = "plugins"\n',
        );
        const captured = capture();

        expect(await main(["run", "--config", config], captured.io)).toBe(0);
        expect(captured.logs.map((log) => log.message)).toEqual([
            "main server started",
            "rebuilding derived data",
            "rebuilt derived data",
            "main server is ready",
            "daemon started",
            "main server is stopping",
        ]);
        expect(captured.logs[4]?.details).toEqual({
            stateDirectory: join(directory, "state"),
            pluginDirectory: join(directory, "plugins"),
            plugins: [],
        });
        expect(captured.daemonLogs.map((log) => log.message)).toEqual([
            "cannot read the plugin directory",
            "daemon stopped",
        ]);
        const db = new Database(join(directory, "data", "agentoscope.db"), { readonly: true });
        expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
        expect(db.query("SELECT version FROM derivation").all()).toEqual([{ version: 1 }]);
        db.close();
    });

    test("fails when the config or the data file cannot be used", async () => {
        const directory = temporaryDirectory();
        const badConfig = join(directory, "bad.toml");
        writeFileSync(badConfig, "[main_server]\nbusy_timeout_ms = -1\n");
        const invalid = capture();
        expect(await main(["run", "--config", badConfig], invalid.io)).toBe(1);
        expect(invalid.logs.map((log) => [log.level, log.message])).toEqual([
            ["error", "invalid config"],
        ]);

        // 데이터 파일 자리에 디렉터리가 있으면 열 수 없습니다.
        mkdirSync(join(directory, "occupied.db"));
        const occupied = join(directory, "occupied.toml");
        writeFileSync(occupied, '[main_server]\ndata_file = "occupied.db"\n');
        const unusable = capture();
        expect(await main(["run", "--config", occupied], unusable.io)).toBe(1);
        expect(unusable.logs.map((log) => [log.level, log.message])).toEqual([
            ["error", "cannot start"],
        ]);
    });

    test("does not start while another daemon uses the state directory", async () => {
        const directory = temporaryDirectory();
        const config = join(directory, "config.toml");
        writeFileSync(
            config,
            '[daemon]\nstate_directory = "state"\n[main_server]\ndata_file = "a.db"\n',
        );
        mkdirSync(join(directory, "state"));
        writeFileSync(join(directory, "state", "daemon.lock"), `${process.pid}\n`);
        const captured = capture();
        expect(await main(["run", "--config", config], captured.io)).toBe(1);
        expect(captured.logs.at(-1)?.message).toBe("another daemon is running");
    });

    test("is the entry point of the executable", () => {
        const child = Bun.spawnSync([process.execPath, MAIN, "version"]);
        expect(child.exitCode).toBe(0);
        expect(child.stdout.toString()).toBe(`${rootPackage.version}\n`);
    });
});
