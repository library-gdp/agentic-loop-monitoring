import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DERIVATION_VERSION, IngestApi, QueryApi } from "@alm/core";
import { InputAdapter } from "@alm/input-adapter";
import { SqliteRepository } from "@alm/persistence";

const directories: string[] = [];
const repositories: SqliteRepository[] = [];

const logger = { info() {}, warn() {}, error() {} };

function server(path?: string) {
  const directory = mkdtempSync(join(tmpdir(), "alm-core-"));
  directories.push(directory);
  const repository = new SqliteRepository({
    path: path ?? join(directory, "data.db"),
    busyTimeoutMs: 1000,
  });
  repositories.push(repository);
  const ingest = new IngestApi(repository, logger);
  ingest.prepare();
  const adapter = new InputAdapter(ingest, logger);
  return { repository, ingest, adapter, query: new QueryApi(repository), directory };
}

let unitCounter = 0;

function unit(
  turn: string,
  position: number,
  events: unknown[],
  agent: { id: string; parent_id?: string } = { id: "main" },
) {
  unitCounter += 1;
  return {
    protocol_version: 1,
    transport_unit_id: `unit-${unitCounter}`,
    source: { agent: "opencode", plugin_version: "0.1.0", host: "box" },
    session: { id: "s1", cwd: "/work" },
    agent,
    turn: { id: turn, position },
    events,
  };
}

let clock = 0;

function at(): string {
  clock += 1;
  return new Date(1_700_000_000_000 + clock * 1000).toISOString();
}

const user = (id: string, text = "prompt") => ({
  event_id: id,
  type: "user_message",
  timestamp: at(),
  text,
});

const final = (id: string, usage = { input_tokens: 10, output_tokens: 5 }) => ({
  event_id: id,
  type: "assistant_message",
  timestamp: at(),
  content: [{ type: "text", text: "answer" }],
  stop_reason: "end_turn",
  usage,
});

const toolRequest = (id: string, toolUseId = "tool-1") => ({
  event_id: id,
  type: "assistant_message",
  timestamp: at(),
  content: [{ type: "tool_use", tool_use_id: toolUseId, name: "read", input: { path: "a" } }],
  stop_reason: "tool_use",
  usage: { input_tokens: 7 },
});

const toolResult = (id: string, toolUseId = "tool-1", extra = {}) => ({
  event_id: id,
  type: "tool_result",
  timestamp: at(),
  tool_use_id: toolUseId,
  output: "result",
  is_error: false,
  ...extra,
});

async function send(adapter: InputAdapter, ...units: unknown[]) {
  for (const item of units) {
    const ack = await adapter.receive(item);
    expect(ack.status).toBe("accepted");
  }
}

function mainPk(query: QueryApi, agentId = "main"): number {
  const agent = query.getSession("opencode", "s1")?.agents.find((a) => a.id === agentId);
  return agent?.pk as number;
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe("ingest", () => {
  test("derives a turn with loops, tool calls and usage", async () => {
    const { adapter, query } = server();
    await send(
      adapter,
      unit("t1", 0, [user("t1", "do it")]),
      unit("t1", 1, [toolRequest("a1"), toolResult("r1")]),
      unit("t1", 3, [final("a2")]),
    );
    const pk = mainPk(query);
    const [turn] = query.listTurns(pk);
    expect(turn).toMatchObject({
      id: "t1",
      prompt: "do it",
      status: "completed",
      loopCount: 2,
      toolCallCount: 1,
      usage: { input_tokens: 17, output_tokens: 5 },
    });
    const detail = query.getTurn(pk, "t1");
    expect(detail?.loops[0]?.toolCalls[0]).toMatchObject({
      id: "tool-1",
      name: "read",
      resultEventId: "r1",
      isError: false,
    });
    expect(detail?.loops[0]?.llmCall.startedAtEstimated).toBe(true);
    expect(query.getToolCallBody(pk, "a1", 0)).toEqual({
      input: { path: "a" },
      output: "result",
      isError: false,
    });
  });

  test("is idempotent when the same unit arrives twice", async () => {
    const { adapter, query } = server();
    const first = unit("t1", 0, [user("t1")]);
    const second = unit("t1", 1, [final("a1")]);
    await send(adapter, first, second, first, second);
    expect(query.listTurns(mainPk(query))).toHaveLength(1);
    expect(query.getTurn(mainPk(query), "t1")?.loops).toHaveLength(1);
  });

  test("keeps usage items that the agent did not record empty", async () => {
    const { adapter, query } = server();
    await send(adapter, unit("t1", 0, [user("t1")]), unit("t1", 1, [final("a1")]));
    const usage = query.getTurn(mainPk(query), "t1")?.loops[0]?.llmCall.usage;
    expect(usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  test("a subagent may arrive before its parent", async () => {
    const { adapter, query } = server();
    await send(
      adapter,
      unit("c1", 0, [user("c1")], { id: "child", parent_id: "main" }),
      unit("t1", 0, [user("t1")]),
      unit("t1", 1, [toolRequest("a1", "task-1")]),
      unit("t1", 2, [toolResult("r1", "task-1", { subagent_id: "child" })]),
    );
    const session = query.getSession("opencode", "s1");
    expect(session?.agents.map((agent) => [agent.id, agent.parentId])).toEqual([
      ["child", "main"],
      ["main", undefined],
    ]);
    const call = query.getTurn(mainPk(query), "t1")?.loops[0]?.toolCalls[0];
    expect(call?.subagentId).toBe("child");
    expect(call?.subagentPk).toBe(mainPk(query, "child"));
  });

  test("a turn without its user_message has no derived row until it arrives", async () => {
    const { adapter, query } = server();
    await send(adapter, unit("t1", 1, [final("a1")]));
    expect(query.listTurns(mainPk(query))).toEqual([]);
    await send(adapter, unit("t1", 0, [user("t1")]));
    expect(query.listTurns(mainPk(query))[0]?.status).toBe("completed");
  });

  test("stores unknown event types and fields without using them", async () => {
    const { adapter, query } = server();
    const future = { event_id: "f1", type: "future", timestamp: at(), extra: 1 };
    const known = { ...final("a1"), mystery: true };
    await send(
      adapter,
      unit("t1", 0, [user("t1")]),
      unit("t1", 1, [future]),
      unit("t1", 2, [known]),
    );
    const pk = mainPk(query);
    expect(JSON.parse(query.getEventBody(pk, "f1") as string)).toMatchObject({ extra: 1 });
    expect(JSON.parse(query.getEventBody(pk, "a1") as string)).toMatchObject({ mystery: true });
    expect(query.getTurn(pk, "t1")?.loops).toHaveLength(1);
  });
});

describe("turn status", () => {
  async function statusOf(events: (() => unknown)[]) {
    const { adapter, query } = server();
    await send(adapter, unit("t1", 0, [user("t1")]));
    let position = 1;
    for (const make of events) {
      await send(adapter, unit("t1", position, [make()]));
      position += 1;
    }
    return query.listTurns(mainPk(query))[0]?.status;
  }

  test("completed by a final response", async () => {
    expect(await statusOf([() => final("a1")])).toBe("completed");
  });

  test("in_progress while a tool result is pending", async () => {
    expect(await statusOf([() => toolRequest("a1")])).toBe("in_progress");
  });

  test("interrupted by turn_interrupted", async () => {
    const interrupted = () => ({ event_id: "i1", type: "turn_interrupted", timestamp: at() });
    expect(await statusOf([() => toolRequest("a1"), interrupted])).toBe("interrupted");
  });

  test("errored by an LLM error that is not retried", async () => {
    const failed = (willRetry: boolean) => () => ({
      event_id: `e-${willRetry}`,
      type: "assistant_message",
      timestamp: at(),
      content: [],
      error: { message: "down", will_retry: willRetry },
    });
    expect(await statusOf([failed(false)])).toBe("errored");
    expect(await statusOf([failed(true)])).toBe("in_progress");
  });

  test("completed by the summary of a manual compaction", async () => {
    const compaction = () => ({
      event_id: "c1",
      type: "compaction",
      timestamp: at(),
      trigger: "manual",
    });
    const summary = () => ({
      event_id: "c2",
      type: "compaction_summary",
      timestamp: at(),
      text: "summary",
    });
    expect(await statusOf([compaction, summary])).toBe("completed");
  });

  test("an auto compaction summary does not end the turn", async () => {
    const compaction = () => ({
      event_id: "c1",
      type: "compaction",
      timestamp: at(),
      trigger: "auto",
    });
    const summary = () => ({
      event_id: "c2",
      type: "compaction_summary",
      timestamp: at(),
      text: "summary",
    });
    expect(await statusOf([compaction, summary])).toBe("in_progress");
  });

  test("errored when the next turn starts", async () => {
    const { adapter, query } = server();
    await send(
      adapter,
      unit("t1", 0, [user("t1")]),
      unit("t1", 1, [toolRequest("a1")]),
      unit("t2", 0, [user("t2")]),
    );
    const statuses = query.listTurns(mainPk(query)).map((turn) => turn.status);
    expect(statuses).toEqual(["errored", "in_progress"]);
  });

  test("resending an old turn does not mark the running turn errored", async () => {
    const { adapter, query } = server();
    const old = [unit("t1", 0, [user("t1")]), unit("t1", 1, [final("a1")])];
    await send(adapter, ...old, unit("t2", 0, [user("t2")]), ...old);
    expect(query.listTurns(mainPk(query)).map((turn) => turn.status)).toEqual([
      "completed",
      "in_progress",
    ]);
  });

  test("a late event for a superseded turn stays errored", async () => {
    const { adapter, query } = server();
    await send(
      adapter,
      unit("t1", 0, [user("t1")]),
      unit("t2", 0, [user("t2")]),
      unit("t1", 1, [toolRequest("a1")]),
    );
    expect(query.getTurn(mainPk(query), "t2")?.status).toBe("errored");
    expect(query.getTurn(mainPk(query), "t1")?.status).toBe("in_progress");
  });

  test("other agents do not affect a turn", async () => {
    const { adapter, query } = server();
    await send(
      adapter,
      unit("t1", 0, [user("t1")]),
      unit("c1", 0, [user("c1")], { id: "child", parent_id: "main" }),
    );
    expect(query.listTurns(mainPk(query))[0]?.status).toBe("in_progress");
  });
});

describe("LLM Call input", () => {
  function inputIds(query: QueryApi, id: string) {
    const lines = query.iterateLlmCallInput(mainPk(query), id);
    return [...(lines ?? [])].map((line) => JSON.parse(line).event_id);
  }

  test("spans earlier turns of the same agent only", async () => {
    const { adapter, query } = server();
    await send(
      adapter,
      unit("t1", 0, [user("t1")]),
      unit("t1", 1, [final("a1")]),
      unit("c1", 0, [user("c1")], { id: "child", parent_id: "main" }),
      unit("t2", 0, [user("t2")]),
      unit("t2", 1, [final("a2")]),
    );
    expect(inputIds(query, "a2")).toEqual(["t1", "a1", "t2"]);
    expect(inputIds(query, "a1")).toEqual(["t1"]);
  });

  test("starts at the nearest compaction", async () => {
    const { adapter, query } = server();
    const compaction = { event_id: "c1", type: "compaction", timestamp: at(), trigger: "auto" };
    const summary = { event_id: "c2", type: "compaction_summary", timestamp: at(), text: "s" };
    await send(
      adapter,
      unit("t1", 0, [user("t1")]),
      unit("t1", 1, [toolRequest("a1"), toolResult("r1")]),
      unit("t1", 3, [compaction, summary]),
      unit("t1", 5, [final("a2")]),
      unit("t2", 0, [user("t2")]),
      unit("t2", 1, [final("a3")]),
    );
    expect(inputIds(query, "a1")).toEqual(["t1"]);
    expect(inputIds(query, "a2")).toEqual(["c1", "c2"]);
    expect(inputIds(query, "a3")).toEqual(["c1", "c2", "a2", "t2"]);
  });
});

describe("compaction", () => {
  test("pairs the summary and adds its usage to the turn", async () => {
    const { adapter, query } = server();
    await send(
      adapter,
      unit("t1", 0, [user("t1")]),
      unit("t1", 1, [
        { event_id: "c1", type: "compaction", timestamp: at(), trigger: "auto" },
        {
          event_id: "c2",
          type: "compaction_summary",
          timestamp: at(),
          text: "s",
          model: "m",
          usage: { input_tokens: 3 },
        },
      ]),
    );
    const pk = mainPk(query);
    const detail = query.getTurn(pk, "t1");
    expect(detail?.compactions[0]).toMatchObject({
      id: "c1",
      summaryEventId: "c2",
      trigger: "auto",
      model: "m",
      usage: { input_tokens: 3 },
    });
    expect(detail?.usage).toEqual({ input_tokens: 3 });
  });
});

describe("sessions", () => {
  test("lists, filters and sums usage of all agents", async () => {
    const { adapter, query } = server();
    await send(
      adapter,
      unit("t1", 0, [user("t1", "first prompt")]),
      unit("t1", 1, [final("a1")]),
      unit("c1", 0, [user("c1")], { id: "child", parent_id: "main" }),
      unit("c1", 1, [final("a2")], { id: "child", parent_id: "main" }),
    );
    const [session] = query.listSessions({ limit: 10, offset: 0 });
    expect(session).toMatchObject({
      id: "s1",
      cwd: "/work",
      host: "box",
      agentCount: 2,
      turnCount: 2,
      firstPrompt: "first prompt",
      usage: { input_tokens: 20, output_tokens: 10 },
    });
    expect(query.listSessions({ limit: 10, offset: 0, cwd: "/other" })).toEqual([]);
    expect(query.listSessions({ limit: 10, offset: 0, agent: "opencode" })).toHaveLength(1);
  });

  test("deletes a whole session and accepts it again", async () => {
    const { adapter, query } = server();
    const units = [
      unit("t1", 0, [user("t1")]),
      unit("t1", 1, [toolRequest("a1"), toolResult("r1")]),
    ];
    await send(adapter, ...units);
    expect(query.deleteSession("opencode", "s1")).toBe(true);
    expect(query.deleteSession("opencode", "s1")).toBe(false);
    expect(query.listSessions({ limit: 10, offset: 0 })).toEqual([]);
    await send(adapter, ...units);
    expect(query.listSessions({ limit: 10, offset: 0 })).toHaveLength(1);
  });
});

describe("rebuilding derived data", () => {
  test("rebuilds from events when the rule version changes", async () => {
    const { adapter, query, repository, ingest } = server();
    await send(
      adapter,
      unit("t1", 0, [user("t1")]),
      unit("t1", 1, [toolRequest("a1")]),
      unit("t2", 0, [user("t2")]),
      unit("t2", 1, [final("a2")]),
    );
    const before = query.listTurns(mainPk(query));
    repository.clearDerived(DERIVATION_VERSION - 1);
    expect(query.listTurns(mainPk(query))).toEqual([]);
    ingest.prepare();
    expect(query.listTurns(mainPk(query))).toEqual(before);
    expect(repository.derivationVersion()).toBe(DERIVATION_VERSION);
  });
});
