import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src";
import { cleanUp, temporaryDirectory } from "./support";

afterEach(cleanUp);

function writeConfig(directory: string, text: string, name = "config.toml"): string {
    const path = join(directory, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, text);
    return path;
}

describe("loadConfig", () => {
    test("uses the defaults when the default config file does not exist", async () => {
        const home = temporaryDirectory();
        const data = join(home, ".local", "share", "agentoscope");
        expect(await loadConfig({ env: { HOME: home } })).toEqual({
            mainServer: { dataFile: join(data, "agentoscope.db"), busyTimeoutMs: 5000 },
            daemon: {
                stateDirectory: join(data, "daemon"),
                pluginDirectory: join(data, "plugins"),
                transport: "in-process",
                ackTimeoutMs: 30_000,
                retryCount: 5,
                retryIntervalMs: 1000,
            },
        });
    });

    test("follows XDG_CONFIG_HOME and AGENTOSCOPE_HOME when they are absolute", async () => {
        const home = temporaryDirectory();
        const configHome = join(home, "config");
        const path = writeConfig(
            join(configHome, "agentoscope"),
            "[main_server]\nbusy_timeout_ms = 2500\n",
        );
        expect(
            await loadConfig({
                env: {
                    HOME: home,
                    XDG_CONFIG_HOME: configHome,
                    AGENTOSCOPE_HOME: join(home, "data"),
                },
            }),
        ).toMatchObject({
            path,
            mainServer: {
                dataFile: join(home, "data", "agentoscope", "agentoscope.db"),
                busyTimeoutMs: 2500,
            },
            daemon: {
                stateDirectory: join(home, "data", "agentoscope", "daemon"),
                pluginDirectory: join(home, "data", "agentoscope", "plugins"),
            },
        });
        const relative = await loadConfig({
            env: { HOME: home, XDG_CONFIG_HOME: "relative", AGENTOSCOPE_HOME: "" },
        });
        expect(relative.mainServer.dataFile).toBe(
            join(home, ".local", "share", "agentoscope", "agentoscope.db"),
        );
    });

    test("resolves a relative data_file against the config file", async () => {
        const directory = temporaryDirectory();
        const path = writeConfig(directory, '[main_server]\ndata_file = "db/main.db"\n');
        expect((await loadConfig({ path })).mainServer.dataFile).toBe(
            join(directory, "db", "main.db"),
        );
    });

    test("reads the daemon settings", async () => {
        const directory = temporaryDirectory();
        const path = writeConfig(
            directory,
            [
                "[daemon]",
                'state_directory = "state"',
                'plugin_directory = "/opt/agentoscope/plugins"',
                'plugins = ["opencode", "claude-code"]',
                'transport = "in-process"',
                "ack_timeout_ms = 10000",
                "retry_count = 0",
                "retry_interval_ms = 250",
            ].join("\n"),
        );
        expect((await loadConfig({ path })).daemon).toEqual({
            stateDirectory: join(directory, "state"),
            pluginDirectory: "/opt/agentoscope/plugins",
            plugins: ["opencode", "claude-code"],
            transport: "in-process",
            ackTimeoutMs: 10_000,
            retryCount: 0,
            retryIntervalMs: 250,
        });
    });

    test("needs the file given with --config", async () => {
        const path = join(temporaryDirectory(), "missing.toml");
        await expect(loadConfig({ path })).rejects.toThrow(ConfigError);
    });

    test("rejects invalid values and unknown keys", async () => {
        const directory = temporaryDirectory();
        const invalid = [
            "[main_server]\nbusy_timeout_ms = 0\n",
            "[main_server]\nbusy_timeout_ms = 1.5\n",
            '[main_server]\nbusy_timeout_ms = "5000"\n',
            '[main_server]\ndata_file = ""\n',
            "[main_server]\ndata_fil = 1\n",
            "[daemon]\nplugins = [1]\n",
            '[daemon]\nplugins = ["Open_Code"]\n',
            '[daemon]\ntransport = "rest"\n',
            "[daemon]\nack_timeout_ms = 5000\n",
            "[daemon]\nretry_count = -1\n",
            '[daemon]\nstate_directory = ""\n',
            "[daemon]\nunknown = 1\n",
            "daemon = 1\n",
            "main_server = 3\n",
            "[main_server\n",
        ];
        for (const [index, text] of invalid.entries()) {
            const path = writeConfig(directory, text, `${index}.toml`);
            await expect(loadConfig({ path })).rejects.toThrow(ConfigError);
        }
    });
});
