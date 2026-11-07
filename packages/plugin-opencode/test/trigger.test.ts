import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Trigger } from "../src/trigger";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function database() {
  const directory = mkdtempSync(join(tmpdir(), "alm-trigger-"));
  directories.push(directory);
  const path = join(directory, "opencode.db");
  const writer = new Database(path);
  writer.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x INTEGER)");
  return { path, writer };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await Bun.sleep(10);
}

test("a commit by another connection fires the trigger", async () => {
  const { path, writer } = database();
  let collected = 0;
  const trigger = new Trigger(
    path,
    async () => {
      collected += 1;
    },
    () => {},
  );
  trigger.start();
  await until(() => collected >= 1);
  await Bun.sleep(50);
  const before = collected;
  writer.exec("INSERT INTO t VALUES (1)");
  await until(() => collected > before);
  await trigger.stop();
  writer.close();
  expect(collected).toBeGreaterThan(before);
});

test("does not overlap collections and runs once more for a notification during one", async () => {
  const { path, writer } = database();
  let running = 0;
  let maximum = 0;
  let calls = 0;
  const trigger = new Trigger(
    path,
    async () => {
      calls += 1;
      running += 1;
      maximum = Math.max(maximum, running);
      await Bun.sleep(20);
      running -= 1;
    },
    () => {},
  );
  trigger.start();
  trigger.fire();
  trigger.fire();
  await until(() => calls >= 2 && running === 0);
  await trigger.stop();
  writer.close();
  expect(maximum).toBe(1);
  expect(calls).toBe(2);
});

test("a failing collection is reported and does not stop the trigger", async () => {
  const { path, writer } = database();
  const errors: unknown[] = [];
  const trigger = new Trigger(
    path,
    async () => {
      throw new Error("locked");
    },
    (error) => errors.push(error),
  );
  trigger.start();
  await until(() => errors.length >= 1);
  await trigger.stop();
  writer.close();
  expect(errors.length).toBeGreaterThan(0);
});

test("starts when the directory does not exist yet", async () => {
  const trigger = new Trigger(
    "/nonexistent/opencode.db",
    async () => {},
    () => {},
  );
  trigger.start();
  await trigger.stop();
});
