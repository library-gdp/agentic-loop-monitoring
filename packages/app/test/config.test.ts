import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config";
import { connectionPath, readAccessUrl, writeConnection } from "../src/connection";
import { launchdPlist, systemdUnit } from "../src/service";

const env = { XDG_DATA_HOME: "/data", XDG_STATE_HOME: "/state" };

describe("parseConfig", () => {
  test("defaults to one process with the opencode plugin and port 0", () => {
    expect(parseConfig("", env)).toMatchObject({
      role: "all",
      stateDirectory: "/state/agentic-loop-monitoring",
      pluginDirectory: "/data/agentic-loop-monitoring/plugins",
      dataFile: "/data/agentic-loop-monitoring/data.db",
      enabledPlugins: ["opencode"],
      transport: { kind: "in-process" },
      visualization: { port: 0 },
    });
  });

  test("reads the transport and plugin options", () => {
    const config = parseConfig(
      `role = "daemon"
[transport]
kind = "rest"
base_url = "http://server:1"
[plugins.opencode]
database = "/x.db"
`,
      env,
    );
    expect(config.transport.baseUrl).toBe("http://server:1");
    expect(config.pluginOptions).toEqual({ opencode: { database: "/x.db" } } as never);
  });

  test("rejects inconsistent settings", () => {
    expect(() => parseConfig(`role = "daemon"`, env)).toThrow("rest");
    expect(() => parseConfig(`[transport]\nkind = "rest"`, env)).toThrow("base_url");
    expect(() => parseConfig(`[visualization]\nport = -1`, env)).toThrow("non-negative");
    expect(() => parseConfig(`[transport]\nkind = "carrier-pigeon"`, env)).toThrow(
      "transport.kind",
    );
  });
});

describe("connection file", () => {
  test("is only readable by the owner and gives an access URL", () => {
    const directory = mkdtempSync(join(tmpdir(), "alm-app-"));
    writeConnection(directory, { url: "http://127.0.0.1:1/", token: "a/b" });
    expect(statSync(connectionPath(directory)).mode & 0o777).toBe(0o600);
    expect(readAccessUrl(directory)).toBe("http://127.0.0.1:1/?token=a%2Fb");
    rmSync(directory, { recursive: true });
  });
});

describe("service files", () => {
  test("systemd restarts on failure with a memory limit", () => {
    const unit = systemdUnit(["/bin/alm", "run"]);
    expect(unit).toContain("ExecStart=/bin/alm run");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("MemoryMax=");
  });

  test("launchd restarts on failure", () => {
    const plist = launchdPlist(["/bin/alm", "run"]);
    expect(plist).toContain("<string>/bin/alm</string>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
  });
});
