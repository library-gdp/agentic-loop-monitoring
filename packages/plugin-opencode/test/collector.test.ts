import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_FILE } from "../src/state";
import { BASE_TIME, FakeOpenCode } from "./opencode-db";
import { cleanUp, collectOnce, outline, temporaryDirectory } from "./support";

afterEach(cleanUp);

function setup() {
    const directory = temporaryDirectory();
    const opencode = new FakeOpenCode(join(directory, "opencode.db"));
    const state = join(directory, "state");
    return { opencode, dbPath: opencode.path, state };
}

const read = {
    part: "prt_read",
    call: "call_read",
    tool: "read",
    input: { filePath: "/a" },
    output: "A",
};
const glob = {
    part: "prt_glob",
    call: "call_glob",
    tool: "glob",
    input: { pattern: "*" },
    output: "a\nb",
};

describe("OpenCode collector", () => {
    test("turns an agent loop into one unit per record", async () => {
        const { opencode, dbPath, state } = setup();
        opencode.session("ses_main");
        const prompt = opencode.user("ses_main", "msg_u1", "summarize");
        opencode.step("ses_main", "msg_a1", "msg_u1", { reasoning: "", tools: [read, glob] });
        const answer = opencode.step("ses_main", "msg_a2", "msg_u1", {
            text: "done",
            reasoning: "think",
        });

        const { units, logs } = await collectOnce(dbPath, state);
        expect(logs).toEqual([]);
        expect(units.map(outline)).toEqual([
            `ses_main ${prompt}@0: user_message`,
            `ses_main ${prompt}@1: assistant[tool_use(read),tool_use(glob)]/tool_use tool_result(call_read) tool_result(call_glob)`,
            `ses_main ${prompt}@4: assistant[reasoning,text]/end_turn`,
        ]);
        expect(units[0]).toEqual({
            session: { id: "ses_main", cwd: "/work/project" },
            agent: { id: "ses_main" },
            turn: { id: prompt, position: 0 },
            events: [
                {
                    event_id: prompt,
                    type: "user_message",
                    text: "summarize",
                    timestamp: expect.any(String),
                },
            ],
        });
        expect(units[2]?.events).toEqual([
            {
                event_id: answer,
                type: "assistant_message",
                timestamp: expect.stringMatching(/^2026-.*Z$/),
                model: "model-1",
                content: [
                    { type: "reasoning", text: "think" },
                    { type: "text", text: "done" },
                ],
                stop_reason: "end_turn",
                usage: {
                    input_tokens: 100,
                    output_tokens: 15,
                    cache_read_tokens: 30,
                    cache_write_tokens: 0,
                    reasoning_tokens: 5,
                },
                started_at: new Date(BASE_TIME).toISOString(),
            },
        ]);
        const toolUnit = units[1];
        expect(toolUnit?.events[0]?.event_id).toMatch(/^evt_\d+:0$/);
        expect(toolUnit?.events[2]).toMatchObject({
            event_id: expect.stringMatching(/^evt_\d+:2$/),
            type: "tool_result",
            tool_use_id: "call_glob",
            output: "a\nb",
            is_error: false,
        });
    });

    test("resumes from the saved position and produces the same events when collected again", async () => {
        const { opencode, dbPath, state } = setup();
        opencode.session("ses_main");
        const prompt = opencode.user("ses_main", "msg_u1", "first");
        opencode.assistant("ses_main", "msg_a1", "msg_u1");
        opencode.stepStart("ses_main", "msg_a1");
        opencode.toolPending("ses_main", "msg_a1", read);

        const first = await collectOnce(dbPath, state);
        expect(first.units.map(outline)).toEqual([`ses_main ${prompt}@0: user_message`]);

        // 같은 step의 나머지가 기록된 뒤 이어 수집하면, 앞서 읽은 part도 이 step에 들어갑니다.
        opencode.toolDone("ses_main", "msg_a1", read);
        opencode.stepFinish("ses_main", "msg_a1", "tool-calls");
        opencode.complete("ses_main", "msg_a1", "msg_u1", "tool-calls");
        opencode.step("ses_main", "msg_a2", "msg_u1", { text: "ok" });
        const second = await collectOnce(dbPath, state);
        expect(second.units.map(outline)).toEqual([
            `ses_main ${prompt}@1: assistant[tool_use(read)]/tool_use tool_result(call_read)`,
            `ses_main ${prompt}@3: assistant[text]/end_turn`,
        ]);

        // 상태를 잃으면 처음부터 수집하며, 같은 event id와 Turn 안 위치가 나옵니다.
        const again = await collectOnce(dbPath, join(state, "lost"));
        expect(again.units).toEqual([...first.units, ...second.units]);
        expect(await collectOnce(dbPath, state)).toEqual({ units: [], logs: [] });
    });

    test("starts over when the saved position is ahead of the database, and forgets deleted sessions", async () => {
        const { opencode, dbPath, state } = setup();
        opencode.session("ses_main");
        opencode.user("ses_main", "msg_u1", "hello");
        opencode.session("ses_gone");
        opencode.user("ses_gone", "msg_g1", "bye");
        expect((await collectOnce(dbPath, state)).units).toHaveLength(2);

        const path = join(state, STATE_FILE);
        const saved = JSON.parse(readFileSync(path, "utf8"));
        saved.sessions.ses_main.seq = 99;
        writeFileSync(path, JSON.stringify(saved));
        opencode.deleteSession("ses_gone");

        const { units } = await collectOnce(dbPath, state);
        expect(units.map((unit) => unit.agent.id)).toEqual(["ses_main"]);
        expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).sessions)).toEqual(["ses_main"]);
    });

    test("finds the Session ID and the parent Agent ID of a Subagent", async () => {
        const { opencode, dbPath, state } = setup();
        opencode.session("ses_main");
        const prompt = opencode.user("ses_main", "msg_u1", "delegate");
        opencode.assistant("ses_main", "msg_a1", "msg_u1");
        opencode.stepStart("ses_main", "msg_a1");
        const task = {
            part: "prt_task",
            call: "call_task",
            tool: "task",
            input: { description: "look", prompt: "look around", subagent_type: "explore" },
            output: '<task id="ses_child" state="completed">\n<task_result>\nfound\n</task_result>\n</task>',
            metadata: { parentSessionId: "ses_main", sessionId: "ses_child" },
        };
        opencode.toolPending("ses_main", "msg_a1", task);
        opencode.session("ses_child", { parent: "ses_main" });
        const childPrompt = opencode.user("ses_child", "msg_c1", "look around");
        opencode.step("ses_child", "msg_c2", "msg_c1", { text: "found" });
        opencode.session("ses_grandchild", { parent: "ses_child" });
        opencode.user("ses_grandchild", "msg_g1", "deeper");
        opencode.toolDone("ses_main", "msg_a1", task);
        opencode.stepFinish("ses_main", "msg_a1", "tool-calls");

        const { units } = await collectOnce(dbPath, state);
        const byAgent = Object.groupBy(units, (unit) => unit.agent.id);
        expect(byAgent.ses_main?.map(outline)).toEqual([
            `ses_main ${prompt}@0: user_message`,
            `ses_main ${prompt}@1: assistant[tool_use(task)]/tool_use tool_result(call_task)`,
        ]);
        expect(byAgent.ses_main?.[1]?.events[1]).toMatchObject({ subagent_id: "ses_child" });
        expect(byAgent.ses_child?.map(outline)).toEqual([
            `ses_child ${childPrompt}@0: user_message`,
            `ses_child ${childPrompt}@1: assistant[text]/end_turn`,
        ]);
        expect(byAgent.ses_child?.[0]).toMatchObject({
            session: { id: "ses_main" },
            agent: { id: "ses_child", parent_id: "ses_main" },
        });
        expect(byAgent.ses_grandchild?.[0]).toMatchObject({
            session: { id: "ses_main" },
            agent: { id: "ses_grandchild", parent_id: "ses_child" },
        });
    });

    test("records a user interruption with the response received so far", async () => {
        const { opencode, dbPath, state } = setup();
        opencode.session("ses_main");
        const prompt = opencode.user("ses_main", "msg_u1", "long job");
        opencode.assistant("ses_main", "msg_a1", "msg_u1");
        opencode.stepStart("ses_main", "msg_a1");
        opencode.text("ses_main", "msg_a1", "prt_text", "starting");
        const bash = {
            part: "prt_bash",
            call: "call_bash",
            tool: "bash",
            input: { command: "sleep 100" },
            error: "Tool execution aborted",
            metadata: { interrupted: true },
        };
        opencode.tool("ses_main", "msg_a1", bash);
        opencode.fail("ses_main", "msg_a1", "msg_u1", {
            name: "MessageAbortedError",
            data: { message: "aborted" },
        });
        // 중단을 기록한 뒤 다시 기록된 message는 다시 넘기지 않습니다.
        opencode.fail("ses_main", "msg_a1", "msg_u1", { name: "MessageAbortedError", data: {} });
        // 응답을 받기 전에 중단하면 turn_interrupted만 넘깁니다.
        const next = opencode.user("ses_main", "msg_u2", "again");
        opencode.assistant("ses_main", "msg_a2", "msg_u2");
        opencode.fail("ses_main", "msg_a2", "msg_u2", { name: "MessageAbortedError", data: {} });

        const { units } = await collectOnce(dbPath, state);
        expect(units.map(outline)).toEqual([
            `ses_main ${prompt}@0: user_message`,
            `ses_main ${prompt}@1: assistant[text,tool_use(bash)]/- tool_result(call_bash,error) turn_interrupted`,
            `ses_main ${next}@0: user_message`,
            `ses_main ${next}@1: turn_interrupted`,
        ]);
    });

    test("records LLM call errors and output length limits", async () => {
        const { opencode, dbPath, state } = setup();
        opencode.session("ses_main");
        const prompt = opencode.user("ses_main", "msg_u1", "hi");
        opencode.assistant("ses_main", "msg_a1", "msg_u1");
        const failed = opencode.fail("ses_main", "msg_a1", "msg_u1", {
            name: "APIError",
            data: { message: "rate limited", statusCode: 429, isRetryable: false },
        });
        const second = opencode.user("ses_main", "msg_u2", "long answer please");
        opencode.assistant("ses_main", "msg_a2", "msg_u2");
        opencode.stepStart("ses_main", "msg_a2");
        opencode.text("ses_main", "msg_a2", "prt_long", "very long");
        opencode.fail("ses_main", "msg_a2", "msg_u2", {
            name: "MessageOutputLengthError",
            data: {},
        });

        const { units } = await collectOnce(dbPath, state);
        expect(units.map(outline)).toEqual([
            `ses_main ${prompt}@0: user_message`,
            `ses_main ${prompt}@1: assistant[]/error(APIError)`,
            `ses_main ${second}@0: user_message`,
            `ses_main ${second}@1: assistant[text]/max_tokens`,
        ]);
        expect(units[1]?.events[0]).toMatchObject({
            event_id: failed,
            model: "model-1",
            error: {
                message: "rate limited",
                code: "APIError",
                status_code: 429,
                will_retry: false,
            },
        });
    });

    test("keeps only the last attempt of a step that OpenCode retried", async () => {
        const { opencode, dbPath, state } = setup();
        opencode.session("ses_main");
        opencode.user("ses_main", "msg_u1", "hi");
        opencode.assistant("ses_main", "msg_a1", "msg_u1");
        opencode.stepStart("ses_main", "msg_a1", "prt_start_1");
        opencode.text("ses_main", "msg_a1", "prt_text_1", "partial");
        opencode.stepStart("ses_main", "msg_a1", "prt_start_2");
        opencode.text("ses_main", "msg_a1", "prt_text_2", "complete");
        opencode.stepFinish("ses_main", "msg_a1", "stop");

        const { units } = await collectOnce(dbPath, state);
        expect(units[1]?.events[0]).toMatchObject({
            content: [{ type: "text", text: "complete" }],
        });
    });

    test("places an automatic compaction inside the Turn and keeps the Turn going", async () => {
        const { opencode, dbPath, state } = setup();
        opencode.session("ses_main");
        const prompt = opencode.user("ses_main", "msg_u1", "big task");
        opencode.step("ses_main", "msg_a1", "msg_u1", { tools: [read] });
        opencode.userMessage("ses_main", "msg_compact");
        opencode.part("ses_main", {
            id: "prt_compact",
            messageID: "msg_compact",
            type: "compaction",
            auto: true,
        });
        opencode.assistant("ses_main", "msg_summary", "msg_compact", {
            summary: true,
            mode: "compaction",
        });
        opencode.stepStart("ses_main", "msg_summary");
        opencode.text("ses_main", "msg_summary", "prt_summary", "we read /a");
        opencode.stepFinish("ses_main", "msg_summary", "stop");
        // tail_start_id를 채워 다시 기록한 compaction part는 다시 넘기지 않습니다.
        opencode.part("ses_main", {
            id: "prt_compact",
            messageID: "msg_compact",
            type: "compaction",
            auto: true,
            tail_start_id: "msg_a1",
        });
        opencode.user("ses_main", "msg_continue", "Continue if you have next steps", {
            synthetic: true,
        });
        opencode.step("ses_main", "msg_a2", "msg_continue", { text: "finished" });

        const { units } = await collectOnce(dbPath, state);
        expect(units.map(outline)).toEqual([
            `ses_main ${prompt}@0: user_message`,
            `ses_main ${prompt}@1: assistant[tool_use(read)]/tool_use tool_result(call_read)`,
            `ses_main ${prompt}@3: compaction(auto)`,
            `ses_main ${prompt}@4: compaction_summary`,
            `ses_main ${prompt}@5: assistant[text]/end_turn`,
        ]);
        expect(units[3]?.events[0]).toMatchObject({
            text: "we read /a",
            model: "model-1",
            usage: { input_tokens: 100 },
        });
    });

    test("starts a Turn with a compaction the user requested", async () => {
        const { opencode, dbPath, state } = setup();
        opencode.session("ses_main");
        opencode.userMessage("ses_main", "msg_compact");
        const request = opencode.part("ses_main", {
            id: "prt_compact",
            messageID: "msg_compact",
            type: "compaction",
            auto: false,
        });
        opencode.assistant("ses_main", "msg_summary", "msg_compact", { summary: true });
        opencode.stepStart("ses_main", "msg_summary");
        opencode.text("ses_main", "msg_summary", "prt_summary", "summary");
        opencode.stepFinish("ses_main", "msg_summary", "stop");
        const next = opencode.user("ses_main", "msg_u2", "next");

        const { units } = await collectOnce(dbPath, state);
        expect(units.map(outline)).toEqual([
            `ses_main ${request}:0@0: user_message compaction(manual)`,
            `ses_main ${request}:0@2: compaction_summary`,
            `ses_main ${next}@0: user_message`,
        ]);
        expect(units[0]?.events[0]).toMatchObject({ event_id: `${request}:0`, text: "" });
    });

    test("does not start Turns for messages the user did not type", async () => {
        const { opencode, dbPath, state } = setup();
        opencode.session("ses_main");
        // 사용자의 shell 명령: synthetic text part와 LLM을 부르지 않은 assistant message
        opencode.user("ses_main", "msg_shell", "The following tool was executed by the user", {
            synthetic: true,
        });
        opencode.assistant("ses_main", "msg_shell_a", "msg_shell");
        opencode.tool("ses_main", "msg_shell_a", {
            ...read,
            part: "prt_shell",
            call: "call_shell",
            tool: "bash",
        });
        // subtask로 실행한 command
        opencode.userMessage("ses_main", "msg_subtask");
        opencode.part("ses_main", {
            id: "prt_subtask",
            messageID: "msg_subtask",
            type: "subtask",
            prompt: "x",
        });
        opencode.step("ses_main", "msg_subtask_a", "msg_subtask", { tools: [read] });
        // 첨부 파일이 앞에 와도 사용자가 입력한 글로 Turn을 시작합니다.
        opencode.userMessage("ses_main", "msg_u1");
        opencode.part("ses_main", {
            id: "prt_file",
            messageID: "msg_u1",
            type: "file",
            url: "file:///a",
        });
        opencode.part("ses_main", {
            id: "prt_file_text",
            messageID: "msg_u1",
            type: "text",
            text: "Called the Read tool",
            synthetic: true,
        });
        const prompt = opencode.part("ses_main", {
            id: "prt_prompt",
            messageID: "msg_u1",
            type: "text",
            text: "explain this file",
        });
        opencode.step("ses_main", "msg_a1", "msg_u1", { text: "it is A" });

        const { units } = await collectOnce(dbPath, state);
        expect(units.map(outline)).toEqual([
            `ses_main ${prompt}@0: user_message`,
            `ses_main ${prompt}@1: assistant[text]/end_turn`,
        ]);
    });

    test("puts late records of an earlier Turn into that Turn", async () => {
        const { opencode, dbPath, state } = setup();
        opencode.session("ses_main");
        const first = opencode.user("ses_main", "msg_u1", "first");
        opencode.assistant("ses_main", "msg_a1", "msg_u1");
        opencode.stepStart("ses_main", "msg_a1");
        // 응답 도중 사용자가 다음 입력을 보냈습니다.
        const second = opencode.user("ses_main", "msg_u2", "second");
        opencode.text("ses_main", "msg_a1", "prt_text", "answer 1");
        opencode.stepFinish("ses_main", "msg_a1", "stop");
        opencode.step("ses_main", "msg_a2", "msg_u2", { text: "answer 2" });

        const { units } = await collectOnce(dbPath, state);
        expect(units.map(outline)).toEqual([
            `ses_main ${first}@0: user_message`,
            `ses_main ${second}@0: user_message`,
            `ses_main ${first}@1: assistant[text]/end_turn`,
            `ses_main ${second}@1: assistant[text]/end_turn`,
        ]);
    });

    test("logs and skips records it cannot interpret", async () => {
        const { opencode, dbPath, state } = setup();
        opencode.session("ses_main");
        const prompt = opencode.user("ses_main", "msg_u1", "hi");
        const broken = opencode.event("ses_main", "message.updated.1", {
            info: { role: "assistant" },
        });
        opencode.event("ses_main", "session.next.prompt.2", { anything: true });
        opencode.step("ses_main", "msg_a1", "msg_u1", { text: "ok" });

        const { units, logs } = await collectOnce(dbPath, state);
        expect(units.map(outline)).toEqual([
            `ses_main ${prompt}@0: user_message`,
            `ses_main ${prompt}@1: assistant[text]/end_turn`,
        ]);
        expect(logs).toEqual([
            {
                level: "warn",
                message: "skipped an OpenCode record that cannot be interpreted",
                details: expect.objectContaining({ eventId: broken, type: "message.updated.1" }),
            },
        ]);
    });

    test("waits for the database and its event table", async () => {
        const directory = temporaryDirectory();
        const dbPath = join(directory, "opencode.db");
        const state = join(directory, "state");
        const missing = await collectOnce(dbPath, state);
        expect(missing.logs.map((log) => log.message)).toEqual([
            "the OpenCode database does not exist yet",
        ]);

        const empty = new FakeOpenCode(dbPath);
        empty.db.exec("DROP TABLE event");
        const noTable = await collectOnce(dbPath, state);
        expect(noTable.logs.map((log) => log.message)).toEqual([
            "the OpenCode database has no event table",
        ]);
        empty.close();
    });
});
