import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestApi, QueryApi } from "@alm/core";
import { InputAdapter } from "@alm/input-adapter";
import { SqliteRepository } from "@alm/persistence";

const directories: string[] = [];
const repositories: SqliteRepository[] = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "alm-input-"));
  directories.push(directory);
  const repository = new SqliteRepository({ path: join(directory, "d.db"), busyTimeoutMs: 100 });
  repositories.push(repository);
  const warnings: string[] = [];
  const logger = { info() {}, warn: (m: string) => warnings.push(m), error() {} };
  const ingest = new IngestApi(repository, logger);
  ingest.prepare();
  return { adapter: new InputAdapter(ingest, logger), repository, warnings };
}

const unit = (overrides: Record<string, unknown> = {}) => ({
  protocol_version: 1,
  transport_unit_id: "u1",
  source: { agent: "opencode", plugin_version: "0.1.0" },
  session: { id: "s1" },
  agent: { id: "a1" },
  turn: { id: "t1", position: 0 },
  events: [
    {
      event_id: "t1",
      type: "user_message",
      timestamp: "2026-10-31T00:00:00.123456+09:00",
      text: "x",
    },
  ],
  ...overrides,
});

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe("InputAdapter", () => {
  test("accepts a valid unit", async () => {
    const { adapter } = setup();
    expect(await adapter.receive(unit())).toEqual({
      protocol_version: 1,
      transport_unit_id: "u1",
      status: "accepted",
    });
  });

  test("rejects a unit with a missing field as not retryable", async () => {
    const { adapter } = setup();
    const { session: _, ...broken } = unit();
    expect(await adapter.receive(broken)).toMatchObject({
      transport_unit_id: "u1",
      status: "rejected",
      retryable: false,
      error: { code: "invalid_transport_unit" },
    });
    expect(await adapter.receive("nope")).toMatchObject({ transport_unit_id: "" });
  });

  test("rejects an unsupported version as retryable", async () => {
    const { adapter } = setup();
    expect(await adapter.receive(unit({ protocol_version: 2 }))).toMatchObject({
      status: "rejected",
      retryable: true,
      error: { code: "unsupported_version" },
    });
  });

  test("drops an invalid event and keeps the others at their positions", async () => {
    const { adapter, repository, warnings } = setup();
    const events = [
      { event_id: "t1", type: "user_message", timestamp: "2026-10-31T00:00:00Z", text: "x" },
      { event_id: "bad", type: "assistant_message", timestamp: "2026-10-31T00:00:01Z" },
      { event_id: "z", type: "turn_interrupted", timestamp: "not a time" },
      {
        event_id: "a1",
        type: "assistant_message",
        timestamp: "2026-10-31T00:00:02Z",
        content: [{ type: "new_block", x: 1 }],
      },
    ];
    expect(await adapter.receive(unit({ events }))).toMatchObject({ status: "accepted" });
    expect(warnings).toHaveLength(2);
    const query = new QueryApi(repository);
    const pk = query.getSession("opencode", "s1")?.agents[0]?.pk as number;
    expect(query.getTurn(pk, "t1")?.loops[0]?.llmCall.position).toBe(3);
  });

  test("reports storage failures as retryable", async () => {
    const { adapter, repository } = setup();
    repository.close();
    repositories.length = 0;
    expect(await adapter.receive(unit())).toMatchObject({
      status: "rejected",
      retryable: true,
      error: { code: "unavailable" },
    });
  });

  test("REST binding maps acks to status codes", async () => {
    const { adapter } = setup();
    const app = adapter.restRoutes();
    const post = (body: string) => app.request("/v1/transport-units", { method: "POST", body });
    expect((await post(JSON.stringify(unit()))).status).toBe(200);
    expect((await post(JSON.stringify(unit({ protocol_version: 9 })))).status).toBe(422);
    const invalid = await post("{");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ transport_unit_id: "", status: "rejected" });
  });
});

test("timestamps keep microseconds and the time zone offset", async () => {
  const { parseTimestampUs } = await import("@alm/core");
  expect(parseTimestampUs("1970-01-01T00:00:01.000001Z")).toBe(1_000_001);
  expect(parseTimestampUs("1970-01-01T09:00:01+09:00")).toBe(1_000_000);
  expect(parseTimestampUs("yesterday")).toBeUndefined();
});
