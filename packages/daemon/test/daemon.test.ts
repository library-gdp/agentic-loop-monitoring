import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginTransportUnit } from "@alm/plugin-api";
import type { Ack, TransportUnit } from "@alm/protocol";
import {
  acquireLock,
  type DaemonLogger,
  loadPlugins,
  NonRetryableTransportError,
  releaseLock,
  restTransport,
  Sender,
  type TransportClient,
} from "../src";

const directories: string[] = [];

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "alm-daemon-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true });
});

function logger() {
  const lines: string[] = [];
  const log: DaemonLogger = {
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
    with: () => log,
  };
  return { log, lines };
}

const pluginUnit = (id: string): PluginTransportUnit => ({
  session: { id: "s" },
  agent: { id: "a" },
  turn: { id, position: 0 },
  events: [{ event_id: id, type: "turn_interrupted", timestamp: "2026-10-31T00:00:00Z" }],
});

const accepted = (unit: TransportUnit): Ack => ({
  protocol_version: 1,
  transport_unit_id: unit.transport_unit_id,
  status: "accepted",
});

const rejected = (unit: TransportUnit, retryable: boolean): Ack => ({
  protocol_version: 1,
  transport_unit_id: unit.transport_unit_id,
  status: "rejected",
  retryable,
  error: { code: "unavailable" },
});

const options = { ackTimeoutMs: 50, retryCount: 2, retryIntervalMs: 1, host: "box" };

describe("Sender", () => {
  test("sends one at a time in order and fills the source", async () => {
    const seen: string[] = [];
    let concurrent = 0;
    const transport: TransportClient = {
      async send(unit) {
        concurrent += 1;
        expect(concurrent).toBe(1);
        seen.push(unit.turn.id);
        expect(unit.protocol_version).toBe(1);
        expect(unit.source).toEqual({ agent: "opencode", plugin_version: "1", host: "box" });
        await Bun.sleep(1);
        concurrent -= 1;
        return accepted(unit);
      },
    };
    const sender = new Sender(transport, options, logger().log);
    for (const id of ["a", "b", "c"]) sender.submit("opencode", "1", pluginUnit(id));
    await sender.close(1000);
    expect(seen).toEqual(["a", "b", "c"]);
  });

  test("retries a retryable rejection with the same unit", async () => {
    const ids: string[] = [];
    const transport: TransportClient = {
      async send(unit) {
        ids.push(unit.transport_unit_id);
        return ids.length < 3 ? rejected(unit, true) : accepted(unit);
      },
    };
    const sender = new Sender(transport, options, logger().log);
    sender.submit("x", "1", pluginUnit("a"));
    await sender.close(1000);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
  });

  test("drops a unit rejected as not retryable and continues", async () => {
    const seen: string[] = [];
    const { log, lines } = logger();
    const transport: TransportClient = {
      async send(unit) {
        seen.push(unit.turn.id);
        return unit.turn.id === "a" ? rejected(unit, false) : accepted(unit);
      },
    };
    const sender = new Sender(transport, options, log);
    sender.submit("x", "1", pluginUnit("a"));
    sender.submit("x", "1", pluginUnit("b"));
    await sender.close(1000);
    expect(seen).toEqual(["a", "b"]);
    expect(lines).toContain("error dropped a rejected transport unit");
  });

  test("treats a missing ack and a thrown error as retryable, then gives up", async () => {
    const { log, lines } = logger();
    let calls = 0;
    const transport: TransportClient = {
      send() {
        calls += 1;
        if (calls === 1) return new Promise(() => {});
        throw new Error("down");
      },
    };
    const sender = new Sender(transport, options, log);
    sender.submit("x", "1", pluginUnit("a"));
    await sender.close(1000);
    expect(calls).toBe(3);
    expect(lines).toContain("error gave up sending a transport unit");
  });
});

describe("loadPlugins", () => {
  const module = (agent: string, version = 1) => `
    export const apiVersion = ${version};
    export function register(registry) {
      registry.register({ agent: ${JSON.stringify(agent)}, version: "1", start() {}, stop() {} });
    }`;

  test("registers valid modules and skips the rest", async () => {
    const path = directory();
    writeFileSync(join(path, "a.js"), module("opencode"));
    writeFileSync(join(path, "b.js"), module("opencode"));
    writeFileSync(join(path, "c.js"), module("Bad_Id"));
    writeFileSync(join(path, "d.js"), module("codex", 99));
    writeFileSync(join(path, "e.js"), "throw new Error('broken')");
    writeFileSync(join(path, "notes.txt"), "ignored");
    const { log, lines } = logger();
    const collection = await loadPlugins(path, log);
    expect([...collection.keys()]).toEqual(["opencode"]);
    expect(lines).toEqual([
      "warn rejected a duplicate plugin",
      "warn rejected an invalid plugin",
      "warn skipped an incompatible plugin module",
      "error failed to load a plugin module",
    ]);
  });

  test("a missing directory is logged and yields no plugins", async () => {
    const { log, lines } = logger();
    expect((await loadPlugins(join(directory(), "nope"), log)).size).toBe(0);
    expect(lines).toHaveLength(1);
  });
});

describe("lock", () => {
  test("a second daemon cannot take the lock until it is released", () => {
    const path = join(directory(), "lock");
    expect(acquireLock(path)).toBe(true);
    expect(acquireLock(path)).toBe(false);
    releaseLock(path);
    expect(acquireLock(path)).toBe(true);
  });

  test("a stale lock of a dead process is replaced", () => {
    const path = join(directory(), "lock");
    writeFileSync(path, "999999999");
    expect(acquireLock(path)).toBe(true);
  });
});

describe("restTransport", () => {
  async function respond(status: number, body: string) {
    const server = Bun.serve({ port: 0, fetch: () => new Response(body, { status }) });
    try {
      const unit = { ...pluginUnit("a") } as unknown as TransportUnit;
      return await restTransport(`http://127.0.0.1:${server.port}/`).send(unit);
    } finally {
      await server.stop(true);
    }
  }

  test("trusts the ack in the body over the status code", async () => {
    const ack = { protocol_version: 1, transport_unit_id: "x", status: "accepted" };
    expect(await respond(500, JSON.stringify(ack))).toEqual(ack as Ack);
  });

  test("without an ack, 2xx and 5xx are retryable and other 4xx are not", async () => {
    const failure = (status: number) => respond(status, "x").catch((error: unknown) => error);
    expect(await failure(200)).not.toBeInstanceOf(NonRetryableTransportError);
    expect(await failure(503)).not.toBeInstanceOf(NonRetryableTransportError);
    expect(await failure(429)).not.toBeInstanceOf(NonRetryableTransportError);
    expect(await failure(404)).toBeInstanceOf(NonRetryableTransportError);
  });
});
