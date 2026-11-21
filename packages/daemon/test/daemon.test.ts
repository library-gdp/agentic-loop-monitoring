import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ack, Plugin, PluginRegistry, TransportUnit } from "@agentoscope/plugin-api";
import {
    DaemonAlreadyRunningError,
    type DaemonOptions,
    LOCK_FILE,
    loadPlugins,
    registerModule,
    startDaemon,
} from "../src";
import {
    cleanUp,
    forgetStartedPlugins,
    type Log,
    pluginUnit,
    recordingLogger,
    startedPlugin,
    temporaryDirectory,
    testPluginSource,
    writePlugin,
} from "./support";

afterEach(() => {
    forgetStartedPlugins();
    cleanUp();
});

function options(directory: string, logs: Log[], sent: TransportUnit[]): DaemonOptions {
    return {
        stateDirectory: join(directory, "state"),
        pluginDirectory: join(directory, "plugins"),
        transport: async (unit): Promise<Ack> => {
            sent.push(unit);
            return {
                protocol_version: 1,
                transport_unit_id: unit.transport_unit_id,
                status: "accepted",
            };
        },
        ackTimeoutMs: 1000,
        retry: { count: 1, intervalMs: 1, maxIntervalMs: 1 },
        host: "box",
        logger: recordingLogger(logs),
    };
}

const fakePlugin = (agent: string): Plugin => ({
    agent,
    version: "1.0.0",
    start: async () => {},
    stop: async () => {},
});

describe("plugin loading", () => {
    test("registers valid plugins and skips the rest with a log", async () => {
        const directory = temporaryDirectory();
        writePlugin(directory, "b-opencode.js", testPluginSource("opencode"));
        writePlugin(directory, "a-codex.js", testPluginSource("codex"));
        writePlugin(directory, "c-duplicate.js", testPluginSource("codex"));
        writePlugin(
            directory,
            "d-old.js",
            "export const apiVersion = 0; export function register() {}",
        );
        writePlugin(directory, "e-broken.js", "this is not javascript (");
        writePlugin(directory, "f-invalid.js", testPluginSource("Bad_Name"));
        writePlugin(directory, "g-no-register.js", "export const apiVersion = 1;");
        writePlugin(directory, "notes.txt", "not a plugin");
        const logs: Log[] = [];

        const collection = await loadPlugins(directory, recordingLogger(logs));
        expect([...collection.keys()]).toEqual(["codex", "opencode"]);
        expect(logs.map((log) => [log.level, log.message])).toEqual([
            ["info", "registered a plugin"],
            ["info", "registered a plugin"],
            ["error", "rejected a plugin for an agent that already has one"],
            ["error", "skipped a plugin built for another plugin API version"],
            ["error", "cannot load a plugin module"],
            ["error", "rejected an invalid plugin"],
            ["error", "skipped a plugin module without a register function"],
        ]);
    });

    test("closes the registry when register returns", () => {
        let saved: PluginRegistry | undefined;
        const collection = new Map<string, Plugin>();
        const logs: Log[] = [];
        registerModule(
            {
                apiVersion: 1,
                register(registry: PluginRegistry) {
                    saved = registry;
                    registry.register(fakePlugin("opencode"));
                },
            },
            "late.js",
            collection,
            recordingLogger(logs),
        );
        saved?.register(fakePlugin("codex"));
        expect([...collection.keys()]).toEqual(["opencode"]);
        expect(logs.at(-1)?.message).toBe("rejected a plugin registered after register returned");
    });

    test("keeps going when the plugin directory does not exist", async () => {
        const logs: Log[] = [];
        const collection = await loadPlugins(
            join(temporaryDirectory(), "none"),
            recordingLogger(logs),
        );
        expect(collection.size).toBe(0);
        expect(logs.map((log) => log.message)).toEqual(["cannot read the plugin directory"]);
    });
});

describe("daemon", () => {
    test("starts the enabled plugins and sends what they submit", async () => {
        const directory = temporaryDirectory();
        writePlugin(join(directory, "plugins"), "opencode.js", testPluginSource("opencode"));
        writePlugin(join(directory, "plugins"), "codex.js", testPluginSource("codex"));
        const logs: Log[] = [];
        const sent: TransportUnit[] = [];
        const daemon = await startDaemon({
            ...options(directory, logs, sent),
            plugins: ["opencode", "claude-code"],
        });
        expect(daemon.started).toEqual(["opencode"]);
        expect(startedPlugin("codex")).toBeUndefined();

        const plugin = startedPlugin("opencode");
        const stateDirectory = join(directory, "state", "plugins", "opencode");
        expect(plugin?.context.stateDirectory).toBe(stateDirectory);
        expect(statSync(stateDirectory).mode & 0o777).toBe(0o700);
        expect(statSync(join(directory, "state")).mode & 0o777).toBe(0o700);

        plugin?.context.logger.warn("skipped a record", { seq: 3 });
        plugin?.context.submit(pluginUnit("t1"));
        await daemon.stop();
        expect(sent.map((unit) => [unit.turn.id, unit.source])).toEqual([
            ["t1", { agent: "opencode", plugin_version: "9.9.9", host: "box" }],
        ]);
        expect(plugin?.stopped).toBe(true);

        // stop 뒤에 넘긴 Transport Unit은 보내지 않습니다.
        plugin?.context.submit(pluginUnit("t2"));
        await Bun.sleep(10);
        expect(sent).toHaveLength(1);
        expect(logs).toContainEqual({
            level: "warn",
            message: "skipped a record",
            details: { agent: "opencode", seq: 3 },
        });
        expect(logs).toContainEqual({
            level: "error",
            message: "no plugin is registered for an enabled agent",
            details: expect.objectContaining({ agent: "claude-code" }),
        });
        expect(existsSync(join(directory, "state", LOCK_FILE))).toBe(false);
    });

    test("starts every registered plugin when none are listed, and survives a failing start", async () => {
        const directory = temporaryDirectory();
        writePlugin(join(directory, "plugins"), "opencode.js", testPluginSource("opencode"));
        writePlugin(
            join(directory, "plugins"),
            "codex.js",
            testPluginSource("codex", { failStart: true }),
        );
        const logs: Log[] = [];
        const daemon = await startDaemon(options(directory, logs, []));
        expect(daemon.started).toEqual(["opencode"]);
        expect(logs).toContainEqual({
            level: "error",
            message: "cannot start a plugin",
            details: { agent: "codex", message: "cannot start" },
        });
        await daemon.stop();
    });

    test("refuses to start while another daemon uses the state directory", async () => {
        const directory = temporaryDirectory();
        const first = await startDaemon(options(directory, [], []));
        await expect(startDaemon(options(directory, [], []))).rejects.toThrow(
            DaemonAlreadyRunningError,
        );
        await first.stop();

        // 끝난 프로세스가 남긴 잠금 파일은 무시합니다.
        writeFileSync(join(directory, "state", LOCK_FILE), "2147483646\n");
        const second = await startDaemon(options(directory, [], []));
        await second.stop();
    });
});
