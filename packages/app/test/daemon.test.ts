/**
 * 빌드한 OpenCode Plugin을 Daemon이 불러와, OpenCode DB에서 수집한 Session Log Event를 프로세스 내 호출로
 * Main Server에 보내고, Query API로 조회하기까지를 확인합니다.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startDaemon } from "@agentoscope/daemon";
import { FakeOpenCode } from "../../plugin-opencode/test/opencode-db";
import { cleanUp, start, temporaryDirectory } from "./support";

const savedDb = process.env.AGENTOSCOPE_OPENCODE_DB;

afterEach(() => {
    if (savedDb === undefined) delete process.env.AGENTOSCOPE_OPENCODE_DB;
    else process.env.AGENTOSCOPE_OPENCODE_DB = savedDb;
    cleanUp();
});

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error("timed out");
        await Bun.sleep(20);
    }
}

describe("daemon with the OpenCode plugin", () => {
    test("stores OpenCode sessions in the Main Server", async () => {
        const directory = temporaryDirectory();
        const plugins = join(directory, "plugins");
        const build = await Bun.build({
            entrypoints: [join(import.meta.dir, "../../plugin-opencode/src/index.ts")],
            target: "bun",
            format: "esm",
            outdir: plugins,
            naming: "opencode.js",
        });
        expect(build.success).toBe(true);

        const opencode = new FakeOpenCode(join(directory, "opencode.db"));
        process.env.AGENTOSCOPE_OPENCODE_DB = opencode.path;
        opencode.session("ses_main");
        opencode.user("ses_main", "msg_u1", "delegate a search");
        opencode.assistant("ses_main", "msg_a1", "msg_u1");
        opencode.stepStart("ses_main", "msg_a1");
        const task = {
            part: "prt_task",
            call: "call_task",
            tool: "task",
            input: { description: "search", prompt: "find the config", subagent_type: "explore" },
            output: "<task>found</task>",
            metadata: { sessionId: "ses_child" },
        };
        opencode.toolPending("ses_main", "msg_a1", task);
        opencode.session("ses_child", { parent: "ses_main" });
        opencode.user("ses_child", "msg_c1", "find the config");
        opencode.step("ses_child", "msg_c2", "msg_c1", {
            tools: [{ part: "prt_glob", call: "call_glob", tool: "glob", input: {}, output: "a" }],
        });
        opencode.step("ses_child", "msg_c3", "msg_c1", { text: "found it" });
        opencode.toolDone("ses_main", "msg_a1", task);
        opencode.stepFinish("ses_main", "msg_a1", "tool-calls");
        opencode.complete("ses_main", "msg_a1", "msg_u1", "tool-calls");

        const { server } = await start();
        const daemon = await startDaemon({
            stateDirectory: join(directory, "state"),
            pluginDirectory: plugins,
            plugins: ["opencode"],
            transport: server.receive,
            ackTimeoutMs: 10_000,
            retry: { count: 3, intervalMs: 10, maxIntervalMs: 100 },
            host: "box",
            logger: { info() {}, warn() {}, error() {} },
        });
        try {
            expect(daemon.started).toEqual(["opencode"]);
            const session = { agentKind: "opencode", sessionId: "ses_main" };
            const child = await waitFor(() => {
                const turns = server.query.listTurns({ ...session, agentId: "ses_child" });
                return turns?.[0]?.status === "completed" ? turns : undefined;
            });
            expect(child.map((turn) => [turn.promptPreview, turn.loopCount])).toEqual([
                ["find the config", 2],
            ]);

            // Main Agent의 Turn은 Subagent가 끝난 뒤에 이어집니다.
            opencode.step("ses_main", "msg_a2", "msg_u1", { text: "the config is in a" });
            const main = await waitFor(() => {
                const turns = server.query.listTurns({ ...session, agentId: "ses_main" });
                return turns?.[0]?.status === "completed" ? turns : undefined;
            });
            expect(main).toHaveLength(1);

            const detail = server.query.getSession(session);
            expect(detail).toMatchObject({ cwd: "/work/project", host: "box" });
            expect(
                detail?.agents.map((agent) => [agent.agentId, agent.parentId ?? null]).sort(),
            ).toEqual([
                ["ses_child", "ses_main"],
                ["ses_main", null],
            ]);
            const calls = server.query.listLlmCalls(session) ?? [];
            expect(calls).toHaveLength(4);
            const delegation = server.query.getToolCall({
                ...session,
                agentId: "ses_main",
                llmCallId: calls.find((call) => call.agentId === "ses_main")?.id ?? "",
                ordinal: 0,
            });
            expect(delegation).toMatchObject({ name: "task", subagentId: "ses_child" });
        } finally {
            await daemon.stop();
            opencode.close();
        }
    });
});
