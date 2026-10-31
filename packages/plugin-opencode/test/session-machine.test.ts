import { describe, expect, test } from "bun:test";
import type { AssistantMessageEvent, PluginTransportUnit } from "@alm/plugin-api";
import { type Checkpoint, SessionMachine } from "../src/session-machine";
import { events, Log, types } from "./fixture";

function machine(checkpoint?: Checkpoint) {
  const units: PluginTransportUnit[] = [];
  const warnings: string[] = [];
  const instance = new SessionMachine(
    {
      session: { id: "ses_a", cwd: "/work" },
      agent: { id: "ses_a" },
      submit: (unit) => units.push(unit),
      warn: (message) => warnings.push(message),
    },
    checkpoint,
  );
  return { instance, units, warnings };
}

function collect(log: Log, checkpoint?: Checkpoint) {
  const result = machine(checkpoint);
  for (const row of log.rows) {
    if (row.seq > (checkpoint?.seq ?? -1)) result.instance.accept(row);
  }
  return result;
}

function completedTool(output = "done") {
  return { status: "completed", output, title: "t", metadata: {} };
}

describe("LLM Call", () => {
  function conversation() {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "hello" }]);
    log.llm("msg_02", "msg_01", "tool-calls", () => {
      log.text("msg_02", "thinking", "reasoning");
      log.tool("msg_02", "call_1", "read", { path: "a" }, completedTool("file"));
      log.tool(
        "msg_02",
        "call_2",
        "glob",
        { pattern: "*" },
        {
          status: "error",
          error: "boom",
        },
      );
    });
    log.llm("msg_03", "msg_01", "stop", () => log.text("msg_03", "answer"));
    return log;
  }

  test("one assistant message becomes one unit with its tool results", () => {
    const { units, instance } = collect(conversation());
    expect(types(units)).toEqual([
      "user_message",
      "assistant_message",
      "tool_result",
      "tool_result",
      "assistant_message",
    ]);
    expect(units.map((unit) => unit.turn)).toEqual([
      { id: "msg_01", position: 0 },
      { id: "msg_01", position: 1 },
      { id: "msg_01", position: 4 },
    ]);
    expect(instance.settled).toBe(true);
  });

  test("maps content, stop reason, usage and tool results", () => {
    const { units } = collect(conversation());
    const [, first] = units;
    const assistant = first?.events[0] as AssistantMessageEvent;
    expect(assistant.content).toEqual([
      { type: "reasoning", text: "thinking" },
      { type: "tool_use", tool_use_id: "call_1", name: "read", input: { path: "a" } },
      { type: "tool_use", tool_use_id: "call_2", name: "glob", input: { pattern: "*" } },
    ]);
    expect(assistant.stop_reason).toBe("tool_use");
    expect(assistant.model).toBe("model-a");
    expect(assistant.usage).toEqual({
      input_tokens: 100,
      output_tokens: 10,
      reasoning_tokens: 1,
      cache_read_tokens: 50,
      cache_write_tokens: 0,
    });
    expect(first?.events[1]).toMatchObject({ output: "file", is_error: false });
    expect(first?.events[2]).toMatchObject({ output: "boom", is_error: true });
  });

  test("the response time precedes the tool results that it requested", () => {
    const { units } = collect(conversation());
    const [assistant, result] = units[1]?.events ?? [];
    expect(Date.parse(assistant?.timestamp ?? "")).toBeLessThanOrEqual(
      Date.parse(result?.timestamp ?? ""),
    );
  });

  test("omits an empty encrypted reasoning block", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "hi" }]);
    log.llm("msg_02", "msg_01", "stop", () => {
      log.text("msg_02", "", "reasoning");
      log.text("msg_02", "answer");
    });
    const assistant = collect(log).units[1]?.events[0] as AssistantMessageEvent;
    expect(assistant.content).toEqual([{ type: "text", text: "answer" }]);
  });

  test.each([
    ["stop", "end_turn"],
    ["tool-calls", "tool_use"],
    ["length", "max_tokens"],
    ["content-filter", "refusal"],
    ["unknown", "other"],
  ])("maps finish %s to %s", (finish, stopReason) => {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "hi" }]);
    log.llm("msg_02", "msg_01", finish, () => log.text("msg_02", "x"));
    expect(collect(log).units[1]?.events[0]).toMatchObject({ stop_reason: stopReason });
  });

  test("an LLM error becomes error with will_retry false and no usage", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "hi" }]);
    const created = log.assistantStart("msg_02", "msg_01");
    log.assistantEnd("msg_02", "msg_01", created, {
      error: { name: "APIError", data: { message: "overloaded", statusCode: 529 } },
    });
    const assistant = collect(log).units[1]?.events[0] as AssistantMessageEvent;
    expect(assistant.content).toEqual([]);
    expect(assistant.error).toEqual({
      message: "overloaded",
      code: "APIError",
      status_code: 529,
      will_retry: false,
    });
    expect(assistant.stop_reason).toBeUndefined();
    expect(assistant.usage).toBeUndefined();
  });

  test("an output length error is max_tokens, not an error", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "hi" }]);
    const created = log.assistantStart("msg_02", "msg_01");
    log.stepStart("msg_02");
    log.text("msg_02", "cut");
    log.assistantEnd("msg_02", "msg_01", created, {
      error: { name: "MessageOutputLengthError", data: {} },
    });
    const assistant = collect(log).units[1]?.events[0] as AssistantMessageEvent;
    expect(assistant.error).toBeUndefined();
    expect(assistant.stop_reason).toBe("max_tokens");
  });
});

describe("interrupt", () => {
  test("a user abort keeps partial output and adds turn_interrupted", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "hi" }]);
    const created = log.assistantStart("msg_02", "msg_01");
    log.stepStart("msg_02");
    log.tool(
      "msg_02",
      "call_1",
      "bash",
      { command: "sleep" },
      {
        status: "error",
        error: "Tool execution aborted",
        metadata: { interrupted: true },
      },
    );
    log.assistantEnd("msg_02", "msg_01", created, {
      error: { name: "MessageAbortedError", data: { message: "Aborted" } },
    });
    const { units } = collect(log);
    expect(types(units)).toEqual([
      "user_message",
      "assistant_message",
      "tool_result",
      "turn_interrupted",
    ]);
    const assistant = units[1]?.events[0] as AssistantMessageEvent;
    expect(assistant.error).toBeUndefined();
    expect(assistant.usage).toBeUndefined();
  });

  test("an abort before any response is only turn_interrupted", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "hi" }]);
    const created = log.assistantStart("msg_02", "msg_01");
    log.assistantEnd("msg_02", "msg_01", created, {
      error: { name: "MessageAbortedError", data: { message: "Aborted" } },
    });
    expect(types(collect(log).units)).toEqual(["user_message", "turn_interrupted"]);
  });
});

describe("compaction", () => {
  test("auto compaction stays in the turn and the continue message is context", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "hi" }]);
    log.llm("msg_02", "msg_01", "tool-calls", () => {
      log.tool("msg_02", "call_1", "read", {}, completedTool());
    });
    log.user("msg_03", [{ type: "compaction", auto: true }]);
    const created = log.assistantStart("msg_04", "msg_03", { summary: true });
    log.stepStart("msg_04");
    log.text("msg_04", "summary of the work");
    log.stepFinish("msg_04", "stop");
    log.assistantEnd("msg_04", "msg_03", created, { summary: true, finish: "stop" });
    log.user("msg_05", [
      { type: "text", text: "Continue if you have next steps", synthetic: true },
    ]);
    log.llm("msg_06", "msg_05", "stop", () => log.text("msg_06", "done"));

    const { units, instance } = collect(log);
    expect(types(units)).toEqual([
      "user_message",
      "assistant_message",
      "tool_result",
      "compaction",
      "compaction_summary",
      "context_message",
      "assistant_message",
    ]);
    expect(new Set(events(units).map((event) => event.turn))).toEqual(new Set(["msg_01"]));
    expect(units[2]?.events[0]).toMatchObject({ type: "compaction", trigger: "auto" });
    expect(units[2]?.events[1]).toMatchObject({
      text: "summary of the work",
      model: "model-a",
      usage: { input_tokens: 100 },
    });
    expect(instance.settled).toBe(true);
  });

  test("manual compaction starts a turn with an empty prompt", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "compaction", auto: false }]);
    const created = log.assistantStart("msg_02", "msg_01", { summary: true });
    log.stepStart("msg_02");
    log.text("msg_02", "summary");
    log.stepFinish("msg_02", "stop");
    log.assistantEnd("msg_02", "msg_01", created, { summary: true, finish: "stop" });
    const { units } = collect(log);
    expect(events(units).map((event) => [event.type, event.position])).toEqual([
      ["user_message", 0],
      ["compaction", 1],
      ["compaction_summary", 2],
    ]);
    expect(units[0]?.events[0]).toMatchObject({ text: "" });
    expect(units[1]?.events[0]).toMatchObject({ trigger: "manual" });
  });

  test("a failed summary becomes an LLM error after compaction", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "compaction", auto: false }]);
    const created = log.assistantStart("msg_02", "msg_01", { summary: true });
    log.assistantEnd("msg_02", "msg_01", created, {
      summary: true,
      error: { name: "UnknownError", data: { message: "failed" } },
    });
    expect(types(collect(log).units)).toEqual(["user_message", "compaction", "assistant_message"]);
  });
});

describe("messages without an LLM call", () => {
  test("a user shell waits for the next prompt and joins that turn", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "first" }]);
    log.llm("msg_02", "msg_01", "stop", () => log.text("msg_02", "ok"));
    log.user("msg_03", [
      { type: "text", text: "The following tool was executed by the user", synthetic: true },
    ]);
    const created = log.assistantStart("msg_04", "msg_03");
    log.tool("msg_04", "call_1", "bash", { command: "ls" }, completedTool("a.txt"));
    log.assistantEnd("msg_04", "msg_03", created, {});

    const before = collect(log);
    expect(types(before.units)).toEqual(["user_message", "assistant_message"]);
    expect(before.instance.settled).toBe(false);

    log.user("msg_05", [{ type: "text", text: "second" }]);
    log.llm("msg_06", "msg_05", "stop", () => log.text("msg_06", "ok"));
    const { units } = collect(log);
    expect(events(units).map((event) => [event.type, event.turn])).toEqual([
      ["user_message", "msg_01"],
      ["assistant_message", "msg_01"],
      ["user_message", "msg_05"],
      ["context_message", "msg_05"],
      ["context_message", "msg_05"],
      ["assistant_message", "msg_05"],
    ]);
    expect(units[4]?.events[0]).toMatchObject({ text: expect.stringContaining("a.txt") });
  });

  test("a subtask records its tool after the message ends and stays in the turn", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "subtask", prompt: "do it", description: "d", agent: "x" }]);
    const created = log.assistantStart("msg_02", "msg_01");
    const start = log.now();
    const part = { type: "tool", callID: "01ABC", tool: "task" };
    log.part("prt_task", "msg_02", {
      ...part,
      state: { status: "running", input: { prompt: "do it" }, time: { start } },
    });
    log.assistantEnd("msg_02", "msg_01", created, { finish: "tool-calls" });
    log.part("prt_task", "msg_02", {
      ...part,
      state: {
        status: "completed",
        input: { prompt: "do it" },
        output: "subtask result",
        metadata: { sessionId: "ses_child" },
        time: { start, end: log.now() },
      },
    });
    log.user("msg_03", [{ type: "text", text: "Summarize the task", synthetic: true }]);
    log.llm("msg_04", "msg_03", "stop", () => log.text("msg_04", "summary"));

    const { units } = collect(log);
    expect(types(units)).toEqual([
      "user_message",
      "context_message",
      "context_message",
      "assistant_message",
    ]);
    expect(units[0]?.events[0]).toMatchObject({ text: "do it" });
    expect(units[1]?.events[0]).toMatchObject({ text: expect.stringContaining("subtask result") });
  });
});

describe("subagent", () => {
  test("a task tool result carries the subagent id", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "hi" }]);
    log.llm("msg_02", "msg_01", "tool-calls", () => {
      log.tool(
        "msg_02",
        "call_1",
        "task",
        { prompt: "go" },
        {
          ...completedTool("<task/>"),
          metadata: { sessionId: "ses_child", parentSessionId: "ses_a" },
        },
      );
    });
    expect(collect(log).units[1]?.events[1]).toMatchObject({
      type: "tool_result",
      subagent_id: "ses_child",
    });
  });
});

describe("message order", () => {
  test("a prompt queued while a response runs waits for that response", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "first" }]);
    const created = log.assistantStart("msg_02", "msg_01");
    log.stepStart("msg_02");
    log.user("msg_03", [{ type: "text", text: "queued" }]);
    log.text("msg_02", "answer");
    log.stepFinish("msg_02", "stop");
    log.assistantEnd("msg_02", "msg_01", created, { finish: "stop" });
    log.llm("msg_04", "msg_03", "stop", () => log.text("msg_04", "second"));
    expect(events(collect(log).units).map((event) => [event.type, event.turn])).toEqual([
      ["user_message", "msg_01"],
      ["assistant_message", "msg_01"],
      ["user_message", "msg_03"],
      ["assistant_message", "msg_03"],
    ]);
  });

  test("a message left unfinished by a crash ends when the next message starts", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "first" }]);
    log.assistantStart("msg_02", "msg_01");
    log.stepStart("msg_02");
    log.part("prt_x", "msg_02", {
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: { status: "running", input: { command: "x" }, time: { start: 5_000 } },
    });
    log.user("msg_03", [{ type: "text", text: "second" }]);
    log.llm("msg_04", "msg_03", "stop", () => log.text("msg_04", "ok"));
    const { units } = collect(log);
    expect(types(units)).toEqual([
      "user_message",
      "assistant_message",
      "user_message",
      "assistant_message",
    ]);
    expect(units[1]?.events[0]).toMatchObject({
      content: [{ type: "tool_use", tool_use_id: "call_1", name: "bash" }],
    });
  });

  test("an empty message left unfinished is not reported as a final response", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "first" }]);
    log.assistantStart("msg_02", "msg_01");
    log.user("msg_03", [{ type: "text", text: "second" }]);
    log.llm("msg_04", "msg_03", "stop", () => log.text("msg_04", "ok"));
    expect(types(collect(log).units)).toEqual([
      "user_message",
      "user_message",
      "assistant_message",
    ]);
  });

  test("later updates of finished messages are ignored", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "hi" }]);
    log.llm("msg_02", "msg_01", "stop", () => log.text("msg_02", "ok"));
    log.message({ id: "msg_01", role: "user", time: { created: 1 }, summary: { diffs: [] } });
    log.part("prt_msg_02_text", "msg_02", { type: "text", text: "changed" });
    expect(types(collect(log).units)).toEqual(["user_message", "assistant_message"]);
  });

  test("a removed message that is still in memory is not sent", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "hi" }]);
    log.assistantStart("msg_02", "msg_01");
    log.raw("message.removed.1", { sessionID: "ses_a", messageID: "msg_02" });
    log.llm("msg_03", "msg_01", "stop", () => log.text("msg_03", "ok"));
    expect(events(collect(log).units).map((event) => event.event_id)).toEqual(["msg_01", "msg_03"]);
  });
});

describe("skipping", () => {
  test("ignores unknown record types and logs records it cannot read", () => {
    const log = new Log();
    log.raw("session.updated.1", {});
    log.raw("message.updated.2", { nope: true });
    log.raw("message.updated.1", { info: { role: "system" } });
    log.rows.push({ id: "evt_x", seq: 3, type: "message.part.updated.1", data: "{not json" });
    const { units, warnings } = collect(log);
    expect(units).toEqual([]);
    expect(warnings).toHaveLength(2);
  });
});

describe("resuming", () => {
  function conversation() {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "hi" }]);
    log.llm("msg_02", "msg_01", "tool-calls", () => {
      log.tool("msg_02", "call_1", "read", {}, completedTool());
    });
    log.llm("msg_03", "msg_01", "stop", () => log.text("msg_03", "ok"));
    return log;
  }

  test("resuming from any checkpoint gives the same ids and positions", () => {
    const log = conversation();
    const full = events(collect(log).units).map((event) => [event.event_id, event.position]);

    for (let stop = 0; stop < log.rows.length; stop += 1) {
      const first = machine();
      for (const row of log.rows.slice(0, stop)) first.instance.accept(row);
      const second = collect(log, first.instance.checkpoint);
      const merged = new Map(
        [...events(first.units), ...events(second.units)].map((event) => [
          event.event_id,
          event.position,
        ]),
      );
      expect([...merged]).toEqual(full as [string, number][]);
    }
  });

  test("the checkpoint stays before a message that is still in memory", () => {
    const log = new Log();
    log.user("msg_01", [{ type: "text", text: "hi" }]);
    log.llm("msg_02", "msg_01", "stop", () => log.text("msg_02", "ok"));
    const settledAt = log.rows.length - 1;
    log.user("msg_03", [{ type: "text", text: "more" }]);
    log.assistantStart("msg_04", "msg_03");
    const { instance } = collect(log);
    expect(instance.checkpoint.seq).toBe(settledAt);
    expect(instance.seq).toBe(log.rows.length - 1);
  });
});
