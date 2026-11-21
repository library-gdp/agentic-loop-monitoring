import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import {
    PLUGIN_API_VERSION,
    type Plugin,
    type PluginContext,
    type PluginTransportUnit,
} from "@agentoscope/plugin-api";
import packageJson from "../package.json" with { type: "json" };
import { resolveDbPath } from "../src/config";
import * as pluginModule from "../src/index";
import { createOpenCodePlugin } from "../src/plugin";
import { FakeOpenCode } from "./opencode-db";
import { cleanUp, type Log, recordingLogger, temporaryDirectory } from "./support";

const running: Plugin[] = [];

afterEach(async () => {
    for (const plugin of running.splice(0)) await plugin.stop();
    cleanUp();
});

function context(units: PluginTransportUnit[], logs: Log[], stateDirectory: string): PluginContext {
    mkdirSync(stateDirectory, { recursive: true });
    return { submit: (unit) => units.push(unit), logger: recordingLogger(logs), stateDirectory };
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("timed out");
        await Bun.sleep(20);
    }
}

describe("OpenCode plugin module", () => {
    test("registers one plugin without doing anything else", () => {
        const registered: Plugin[] = [];
        expect(pluginModule.apiVersion).toBe(PLUGIN_API_VERSION);
        pluginModule.register({ register: (plugin) => registered.push(plugin) });
        expect(registered.map((plugin) => [plugin.agent, plugin.version])).toEqual([
            ["opencode", packageJson.version],
        ]);
    });

    test("bundles into one ES module that imports only runtime modules", async () => {
        const out = temporaryDirectory();
        const build = await Bun.build({
            entrypoints: [join(import.meta.dir, "../src/index.ts")],
            target: "bun",
            format: "esm",
            outdir: out,
            naming: "opencode.js",
        });
        expect(build.success).toBe(true);
        const text = await Bun.file(join(out, "opencode.js")).text();
        const imports = [...text.matchAll(/^import .* from "([^"]+)";?$/gm)].map(
            (match) => match[1],
        );
        expect(imports.length).toBeGreaterThan(0);
        for (const specifier of imports) {
            const name = (specifier ?? "").replace(/^node:/, "");
            expect({
                specifier,
                builtin: name.startsWith("bun:") || builtinModules.includes(name),
            }).toEqual({
                specifier,
                builtin: true,
            });
        }
        const loaded = await import(join(out, "opencode.js"));
        expect(loaded.apiVersion).toBe(PLUGIN_API_VERSION);
    });
});

describe("OpenCode plugin configuration", () => {
    test("reads AGENTOSCOPE_OPENCODE_DB and falls back to the default location", () => {
        expect(resolveDbPath({}, "/home/me")).toEqual({
            path: "/home/me/.local/share/opencode/opencode.db",
        });
        expect(resolveDbPath({ AGENTOSCOPE_OPENCODE_DB: "" }, "/home/me")).toEqual({
            path: "/home/me/.local/share/opencode/opencode.db",
        });
        expect(resolveDbPath({ AGENTOSCOPE_OPENCODE_DB: "/data/oc.db" }, "/home/me")).toEqual({
            path: "/data/oc.db",
        });
        expect(resolveDbPath({ AGENTOSCOPE_OPENCODE_DB: "oc.db" }, "/home/me")).toHaveProperty(
            "error",
        );
    });

    test("does not collect when the configured path is not absolute", async () => {
        const units: PluginTransportUnit[] = [];
        const logs: Log[] = [];
        const plugin = createOpenCodePlugin({ env: { AGENTOSCOPE_OPENCODE_DB: "relative.db" } });
        running.push(plugin);
        await plugin.start(context(units, logs, temporaryDirectory()));
        expect(logs.map((log) => [log.level, log.message])).toEqual([
            ["error", "not collecting OpenCode sessions"],
        ]);
    });
});

describe("OpenCode plugin trigger", () => {
    test("collects at start, on WAL changes and periodically", async () => {
        const directory = temporaryDirectory();
        const dbPath = join(directory, "opencode.db");
        const opencode = new FakeOpenCode(dbPath);
        opencode.session("ses_main");
        opencode.user("ses_main", "msg_u1", "before start");

        const units: PluginTransportUnit[] = [];
        const logs: Log[] = [];
        // 주기적인 수집은 길게 두어, 아래의 수집이 변경 알림으로 일어났음을 확인합니다.
        const plugin = createOpenCodePlugin({
            env: { AGENTOSCOPE_OPENCODE_DB: dbPath },
            rescanIntervalMs: 60_000,
        });
        running.push(plugin);
        await plugin.start(context(units, logs, join(directory, "state")));
        await waitFor(() => units.length === 1);

        opencode.step("ses_main", "msg_a1", "msg_u1", { text: "answer" });
        await waitFor(() => units.length === 2);
        expect(units[1]?.events[0]).toMatchObject({ type: "assistant_message" });
        opencode.close();
        expect(logs.filter((log) => log.level !== "info")).toEqual([]);
    });

    test("waits for a database that does not exist yet", async () => {
        const directory = temporaryDirectory();
        const dbPath = join(directory, "later", "opencode.db");
        const units: PluginTransportUnit[] = [];
        const logs: Log[] = [];
        const plugin = createOpenCodePlugin({
            env: { AGENTOSCOPE_OPENCODE_DB: dbPath },
            rescanIntervalMs: 50,
        });
        running.push(plugin);
        await plugin.start(context(units, logs, join(directory, "state")));
        await waitFor(() => logs.some((log) => log.message.includes("does not exist")));

        mkdirSync(join(directory, "later"));
        const opencode = new FakeOpenCode(dbPath);
        opencode.session("ses_main");
        opencode.user("ses_main", "msg_u1", "hello");
        await waitFor(() => units.length === 1);
        opencode.close();
    });

    test("stops collecting and submitting when stopped", async () => {
        const directory = temporaryDirectory();
        const dbPath = join(directory, "opencode.db");
        const opencode = new FakeOpenCode(dbPath);
        opencode.session("ses_main");
        opencode.user("ses_main", "msg_u1", "one");
        const units: PluginTransportUnit[] = [];
        const plugin = createOpenCodePlugin({
            env: { AGENTOSCOPE_OPENCODE_DB: dbPath },
            rescanIntervalMs: 20,
        });
        await plugin.start(context(units, [], join(directory, "state")));
        await waitFor(() => units.length === 1);
        await plugin.stop();

        opencode.user("ses_main", "msg_u2", "two");
        await Bun.sleep(150);
        expect(units).toHaveLength(1);
        opencode.close();
    });
});
