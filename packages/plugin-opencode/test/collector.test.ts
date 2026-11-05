import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginTransportUnit } from "@alm/plugin-api";
import { Collector } from "../src/collector";
import { resolveDatabasePath } from "../src/database-path";
import { Log } from "./fixture";

const directories: string[] = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "alm-collector-"));
  directories.push(directory);
  const path = join(directory, "opencode.db");
  const db = new Database(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
    CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL);
  `);
  const units: PluginTransportUnit[] = [];
  const warnings: string[] = [];
  const logger = {
    info() {},
    warn: (message: string) => warnings.push(message),
    error() {},
  };
  const state = join(directory, "positions.json");
  const create = () =>
    new Collector(path, state, { submit: (unit) => units.push(unit), logger }, () => false);
  return { db, path, units, warnings, state, create };
}

function insert(db: Database, session: string, rows: Log["rows"]): void {
  for (const row of rows) {
    db.query("INSERT INTO event VALUES (?, ?, ?, ?, ?)").run(
      `${session}:${row.id}`,
      session,
      row.seq,
      row.type,
      row.data,
    );
  }
  const seq = rows.at(-1)?.seq ?? 0;
  db.query(
    `INSERT INTO event_sequence VALUES (?, ?)
     ON CONFLICT (aggregate_id) DO UPDATE SET seq = excluded.seq`,
  ).run(session, seq);
}

function turn(): Log {
  const log = new Log();
  log.user("msg_01", [{ type: "text", text: "hi" }]);
  log.llm("msg_02", "msg_01", "stop", () => log.text("msg_02", "ok"));
  return log;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe("Collector", () => {
  test("a subagent uses the root session id and its parent as the parent agent", async () => {
    const { db, units, create } = setup();
    db.query("INSERT INTO session VALUES ('ses_root', NULL, '/root')").run();
    db.query("INSERT INTO session VALUES ('ses_mid', 'ses_root', '/root')").run();
    db.query("INSERT INTO session VALUES ('ses_leaf', 'ses_mid', '/other')").run();
    insert(db, "ses_root", turn().rows);
    insert(db, "ses_leaf", turn().rows);
    const collector = create();
    await collector.collect();
    collector.close();
    const leaf = units.find((unit) => unit.agent.id === "ses_leaf");
    expect(leaf?.session).toEqual({ id: "ses_root", cwd: "/root" });
    expect(leaf?.agent).toEqual({ id: "ses_leaf", parent_id: "ses_mid" });
    const root = units.find((unit) => unit.agent.id === "ses_root");
    expect(root?.agent).toEqual({ id: "ses_root" });
  });

  test("resumes from the saved position after a restart", async () => {
    const { db, units, create } = setup();
    db.query("INSERT INTO session VALUES ('ses_a', NULL, '/a')").run();
    const log = turn();
    insert(db, "ses_a", log.rows);
    const first = create();
    await first.collect();
    first.close();
    expect(units).toHaveLength(2);

    const second = create();
    await second.collect();
    expect(units).toHaveLength(2);

    const next = log.rows.length;
    log.user("msg_03", [{ type: "text", text: "more" }]);
    log.llm("msg_04", "msg_03", "stop", () => log.text("msg_04", "ok"));
    insert(db, "ses_a", log.rows.slice(next));
    await second.collect();
    second.close();
    expect(units.map((unit) => unit.turn)).toEqual([
      { id: "msg_01", position: 0 },
      { id: "msg_01", position: 1 },
      { id: "msg_03", position: 0 },
      { id: "msg_03", position: 1 },
    ]);
  });

  test("collects a session from the start when its log shrank", async () => {
    const { db, units, create } = setup();
    db.query("INSERT INTO session VALUES ('ses_a', NULL, '/a')").run();
    const log = turn();
    insert(db, "ses_a", log.rows);
    const collector = create();
    await collector.collect();
    db.query("DELETE FROM event WHERE aggregate_id = 'ses_a'").run();
    const shorter = new Log();
    shorter.user("msg_09", [{ type: "text", text: "new" }]);
    shorter.llm("msg_10", "msg_09", "stop", () => shorter.text("msg_10", "ok"));
    insert(db, "ses_a", shorter.rows.slice(0, 4));
    await collector.collect();
    collector.close();
    expect(units.map((unit) => unit.events[0].event_id)).toEqual(["msg_01", "msg_02"]);
  });

  test("forgets the position of a deleted session", async () => {
    const { db, state, create } = setup();
    db.query("INSERT INTO session VALUES ('ses_a', NULL, '/a')").run();
    insert(db, "ses_a", turn().rows);
    const collector = create();
    await collector.collect();
    db.query("DELETE FROM event_sequence").run();
    await collector.collect();
    collector.close();
    expect(JSON.parse(await Bun.file(state).text())).toEqual({});
  });

  test("a damaged state file means collecting from the beginning", async () => {
    const { db, units, state, warnings, create } = setup();
    db.query("INSERT INTO session VALUES ('ses_a', NULL, '/a')").run();
    insert(db, "ses_a", turn().rows);
    writeFileSync(state, "{broken");
    const collector = create();
    await collector.collect();
    collector.close();
    expect(units).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  });

  test("waits for the database and its tables to exist", async () => {
    const { path, create, warnings } = setup();
    rmSync(path);
    const collector = create();
    await collector.collect();
    expect(warnings).toEqual([]);
    new Database(path).close();
    await collector.collect();
    collector.close();
    expect(warnings).toHaveLength(1);
  });

  test("does not submit a session whose parent is missing", async () => {
    const { db, units, warnings, create } = setup();
    db.query("INSERT INTO session VALUES ('ses_child', 'ses_gone', '/a')").run();
    insert(db, "ses_child", turn().rows);
    const collector = create();
    await collector.collect();
    await collector.collect();
    collector.close();
    expect(units).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

describe("resolveDatabasePath", () => {
  test("uses XDG_DATA_HOME and OPENCODE_DB like OpenCode", () => {
    expect(resolveDatabasePath(undefined, { XDG_DATA_HOME: "/data" })).toBe(
      "/data/opencode/opencode.db",
    );
    expect(resolveDatabasePath(undefined, { XDG_DATA_HOME: "/d", OPENCODE_DB: "x.db" })).toBe(
      "/d/opencode/x.db",
    );
    expect(resolveDatabasePath("/abs/o.db", { OPENCODE_DB: "x.db" })).toBe("/abs/o.db");
  });
});
