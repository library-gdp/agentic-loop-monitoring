import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
    createIngestService,
    type Repository,
    type TurnStatus,
    type WriteTransaction,
} from "@agentoscope/core";
import { createInputAdapter } from "@agentoscope/input-adapter";
import { openSqliteRepository } from "@agentoscope/persistence";
import {
    at,
    CLOCK_START_US,
    cleanUp,
    compaction,
    DERIVED_TABLES,
    execute,
    final,
    interrupted,
    type Log,
    recordingLogger,
    request,
    result,
    SOURCE_TABLES,
    sendTurn,
    snapshot,
    start,
    summary,
    temporaryDirectory,
    unit,
    us,
    user,
} from "./support";

afterEach(cleanUp);

const SESSION = { agentKind: "claude-code", sessionId: "s1" } as const;
const MAIN = { ...SESSION, agentId: "main" } as const;

function statuses(server: Awaited<ReturnType<typeof start>>["server"], agentId = "main") {
    return Object.fromEntries(
        (server.query.listTurns({ ...SESSION, agentId }) ?? []).map((turn) => [
            turn.turnId,
            turn.status,
        ]),
    ) as Record<string, TurnStatus>;
}

describe("ingest and derive", () => {
    test("builds a turn with loops, tool calls, token usage and the original bodies", async () => {
        const { server } = await start();
        const finalEvent = final("a2", 4, {
            usage: { input_tokens: 30, output_tokens: 5, cache_read_tokens: 100 },
            future_field: { kept: true },
        });
        await sendTurn(
            server,
            "u1",
            [
                user("u1", 0, "Fix the flaky test"),
                request("a1", 2, ["t1", "t2"], {
                    started_at: at(1),
                    usage: { input_tokens: 20, output_tokens: 10 },
                }),
                result("r1", 3, "t1"),
                result("r2", 3.5, "t2", { is_error: true }),
                finalEvent,
            ],
            { cwd: "/work/api", host: "laptop" },
        );

        expect(server.query.getTurn({ ...MAIN, turnId: "u1" })).toEqual({
            turnId: "u1",
            status: "completed",
            promptPreview: "Fix the flaky test",
            promptLength: 18,
            prompt: "Fix the flaky test",
            startedAtUs: us(0),
            endedAtUs: us(4),
            loopCount: 2,
            failedLlmCallCount: 0,
            toolCallCount: 2,
            compactionCount: 0,
            usage: { inputTokens: 50, outputTokens: 15, cacheReadTokens: 100 },
            loops: [
                {
                    id: "a1",
                    llmCall: {
                        id: "a1",
                        turnId: "u1",
                        position: 1,
                        model: "model-a",
                        stopReason: "tool_use",
                        failed: false,
                        startedAtUs: us(1),
                        startedAtEstimated: false,
                        endedAtUs: us(2),
                        usage: { inputTokens: 20, outputTokens: 10 },
                    },
                    toolCalls: [
                        {
                            llmCallId: "a1",
                            ordinal: 0,
                            toolUseId: "t1",
                            name: "read",
                            resultEventId: "r1",
                            startedAtUs: us(2),
                            endedAtUs: us(3),
                            subagentRecorded: false,
                        },
                        {
                            llmCallId: "a1",
                            ordinal: 1,
                            toolUseId: "t2",
                            name: "read",
                            resultEventId: "r2",
                            isError: true,
                            startedAtUs: us(2),
                            endedAtUs: us(3.5),
                            subagentRecorded: false,
                        },
                    ],
                    startedAtUs: us(1),
                    endedAtUs: us(3.5),
                },
                {
                    id: "a2",
                    llmCall: {
                        id: "a2",
                        turnId: "u1",
                        position: 4,
                        model: "model-a",
                        stopReason: "end_turn",
                        failed: false,
                        startedAtUs: us(3.5),
                        startedAtEstimated: true,
                        endedAtUs: us(4),
                        usage: { inputTokens: 30, outputTokens: 5, cacheReadTokens: 100 },
                    },
                    toolCalls: [],
                    startedAtUs: us(3.5),
                    endedAtUs: us(4),
                },
            ],
            compactions: [],
        });
        expect(server.query.getToolCall({ ...MAIN, llmCallId: "a1", ordinal: 1 })).toMatchObject({
            toolUseId: "t2",
            input: { path: "/src/t2.ts" },
            output: "contents of t2",
            isError: true,
        });
        // 받은 Session Log Event는 모르는 필드까지 그대로 남습니다.
        expect(JSON.parse(server.query.getEventBody({ ...SESSION, eventId: "a2" }) ?? "")).toEqual(
            finalEvent,
        );
        expect(server.query.getSession(SESSION)).toEqual({
            ...SESSION,
            cwd: "/work/api",
            host: "laptop",
            startedAtUs: us(0),
            endedAtUs: us(4),
            firstReceivedAtUs: CLOCK_START_US + 1,
            agentCount: 1,
            turnCount: 1,
            usage: { inputTokens: 50, outputTokens: 15, cacheReadTokens: 100 },
            agents: [
                {
                    agentId: "main",
                    turnCount: 1,
                    startedAtUs: us(0),
                    endedAtUs: us(4),
                    usage: { inputTokens: 50, outputTokens: 15, cacheReadTokens: 100 },
                },
            ],
        });
    });

    test("receiving the same transport units again changes nothing but the receipt records", async () => {
        const { server, dataFile } = await start();
        const units = [
            unit("u1", 0, [user("u1", 0)]),
            unit("u1", 1, [request("a1", 1, ["t1"])]),
            unit("u1", 2, [result("r1", 2, "t1")]),
            unit("u1", 3, [final("a2", 3)]),
        ];
        for (const value of units) await server.receive(value);
        const before = snapshot(dataFile, [...SOURCE_TABLES, ...DERIVED_TABLES]);
        for (const value of units) {
            expect((await server.receive(value)).status).toBe("accepted");
        }
        expect(snapshot(dataFile, [...SOURCE_TABLES, ...DERIVED_TABLES])).toEqual(before);
        const db = new Database(dataFile, { readonly: true });
        expect(
            db.query("SELECT stored_count, dropped_count FROM ingest ORDER BY id").all(),
        ).toEqual([
            ...Array(4).fill({ stored_count: 1, dropped_count: 0 }),
            ...Array(4).fill({ stored_count: 0, dropped_count: 0 }),
        ]);
        db.close();
    });

    test("stores unknown event types as received but leaves them out of the activity model", async () => {
        const { server, dataFile } = await start();
        const futureEvent = {
            event_id: "x1",
            type: "system_prompt",
            timestamp: at(1),
            text: "be nice",
        };
        await sendTurn(server, "u1", [user("u1", 0), futureEvent, final("a1", 2)]);
        expect(statuses(server)).toEqual({ u1: "completed" });
        expect(server.query.getTurn({ ...MAIN, turnId: "u1" })?.loops[0]?.llmCall).toMatchObject({
            startedAtUs: us(0),
            startedAtEstimated: true,
        });
        const input = [...(server.query.iterateLlmCallInput({ ...MAIN, llmCallId: "a1" }) ?? [])];
        expect(input.map((event) => event.eventId)).toEqual(["u1"]);
        const db = new Database(dataFile, { readonly: true });
        expect(db.query("SELECT type, body FROM event WHERE event_id = 'x1'").get()).toEqual({
            type: "system_prompt",
            body: JSON.stringify(futureEvent),
        });
        db.close();
    });

    test("keeps token usage absent when the agent did not record it", async () => {
        const { server } = await start();
        await sendTurn(server, "u1", [user("u1", 0), final("a1", 1)]);
        expect(server.query.getTurn({ ...MAIN, turnId: "u1" })?.usage).toEqual({});
        expect(server.query.getSession(SESSION)?.usage).toEqual({});
        expect(
            server.query.getTurn({ ...MAIN, turnId: "u1" })?.loops[0]?.llmCall.usage,
        ).toBeUndefined();
    });

    test("stores a subagent that arrives before its parent and links it from the tool call", async () => {
        const { server } = await start();
        await sendTurn(server, "su1", [user("su1", 1, "Find the CI config"), final("sa1", 2)], {
            agentId: "sub-1",
            parentId: "main",
        });
        await sendTurn(server, "u1", [
            user("u1", 0),
            request("a1", 0.5, ["task-1"]),
            result("r1", 3, "task-1", { subagent_id: "sub-1" }),
            final("a2", 4),
        ]);
        const session = server.query.getSession(SESSION);
        expect(session?.agents.map((agent) => [agent.agentId, agent.parentId])).toEqual([
            ["sub-1", "main"],
            ["main", undefined],
        ]);
        expect(session?.startedAtUs).toBe(us(0));
        expect(
            server.query.getTurn({ ...MAIN, turnId: "u1" })?.loops[0]?.toolCalls[0],
        ).toMatchObject({ subagentId: "sub-1", subagentRecorded: true });
    });

    test("fills empty session and agent fields and logs a different value", async () => {
        const { server, logs } = await start();
        await server.receive(unit("u1", 0, [user("u1", 0)], { agentId: "sub" }));
        await server.receive(
            unit("u1", 1, [final("a1", 1)], {
                agentId: "sub",
                cwd: "/a",
                host: "h",
                parentId: "main",
            }),
        );
        await server.receive(
            unit("u1", 2, [final("a2", 2)], {
                agentId: "sub",
                cwd: "/b",
                host: "h",
                parentId: "other",
            }),
        );
        const session = server.query.getSession(SESSION);
        expect(session).toMatchObject({ cwd: "/a", host: "h" });
        expect(session?.agents[0]?.parentId).toBe("main");
        expect(
            logs
                .filter((log: Log) => log.level === "warn")
                .map((log) => [log.details?.field, log.details?.stored, log.details?.received]),
        ).toEqual([
            ["session.cwd", "/a", "/b"],
            ["agent.parent_id", "main", "other"],
        ]);
    });
});

describe("turn status", () => {
    test("follows the last event of the turn", async () => {
        const { server } = await start();
        await sendTurn(server, "u1", [user("u1", 0), request("a1", 1, ["t1"])]);
        expect(statuses(server)).toEqual({ u1: "in_progress" });
        await sendTurn(server, "u1", [interrupted("i1", 2)], { from: 2 });
        expect(statuses(server)).toEqual({ u1: "interrupted" });
        await sendTurn(server, "u2", [
            user("u2", 3),
            final("a2", 4, {
                error: { message: "overloaded", will_retry: false },
                stop_reason: undefined,
            }),
        ]);
        expect(statuses(server)).toEqual({ u1: "interrupted", u2: "errored" });
        await sendTurn(server, "u3", [
            user("u3", 5, "/compact"),
            compaction("c1", 6, "manual"),
            summary("cs1", 7),
        ]);
        expect(statuses(server).u3).toBe("completed");
    });

    test("an unfinished turn becomes errored when the next turn starts", async () => {
        const { server } = await start();
        await sendTurn(server, "u1", [user("u1", 0), request("a1", 1, ["t1"])]);
        await sendTurn(server, "u2", [user("u2", 2)]);
        expect(statuses(server)).toEqual({ u1: "errored", u2: "in_progress" });
    });

    test("receiving an earlier turn again does not make the running turn errored", async () => {
        const { server } = await start();
        const first = [user("u1", 0), final("a1", 1)];
        await sendTurn(server, "u1", first);
        await sendTurn(server, "u2", [user("u2", 2), request("a2", 3, ["t1"])]);
        await sendTurn(server, "u1", first);
        expect(statuses(server)).toEqual({ u1: "completed", u2: "in_progress" });
    });

    test("a late event of a superseded turn does not bring it back", async () => {
        const { server } = await start();
        await sendTurn(server, "u1", [user("u1", 0), request("a1", 1, ["t1"])]);
        await sendTurn(server, "u2", [user("u2", 2)]);
        await sendTurn(server, "u1", [result("r1", 1.5, "t1")], { from: 2 });
        expect(statuses(server)).toEqual({ u1: "errored", u2: "errored" });
    });

    test("other agents do not affect a turn", async () => {
        const { server } = await start();
        await sendTurn(server, "u1", [user("u1", 0), request("a1", 1, ["t1"])]);
        await sendTurn(server, "su1", [user("su1", 2)], { agentId: "sub-1", parentId: "main" });
        expect(statuses(server)).toEqual({ u1: "in_progress" });
    });
});

describe("LLM Call input", () => {
    test("spans earlier turns in turn order and starts at the nearest compaction", async () => {
        const { server } = await start();
        await sendTurn(server, "u1", [user("u1", 0), final("a1", 1)]);
        await sendTurn(server, "u2", [
            user("u2", 2),
            request("a2", 3, ["t1"]),
            result("r1", 4, "t1"),
            compaction("c1", 5, "auto"),
            summary("cs1", 6),
            final("a3", 7),
        ]);
        await sendTurn(server, "su1", [user("su1", 3.5), final("sa1", 3.7)], {
            agentId: "sub-1",
            parentId: "main",
        });
        const input = (llmCallId: string) =>
            [...(server.query.iterateLlmCallInput({ ...MAIN, llmCallId }) ?? [])].map(
                (event) => event.eventId,
            );
        expect(input("a1")).toEqual(["u1"]);
        expect(input("a2")).toEqual(["u1", "a1", "u2"]);
        expect(input("a3")).toEqual(["c1", "cs1"]);
        expect(server.query.iterateLlmCallInput({ ...MAIN, llmCallId: "missing" })).toBeUndefined();
    });

    test("orders turns by started_at and then by receipt order", async () => {
        const { server } = await start();
        // u2가 먼저 도착했지만 started_at이 늦습니다. u3은 u2와 started_at이 같고 나중에 받았습니다.
        await sendTurn(server, "u2", [user("u2", 5), final("a2", 6)]);
        await sendTurn(server, "u1", [user("u1", 1), final("a1", 2)]);
        await sendTurn(server, "u3", [user("u3", 5), final("a3", 7)]);
        expect(server.query.listTurns(MAIN)?.map((turn) => turn.turnId)).toEqual([
            "u1",
            "u2",
            "u3",
        ]);
        const input = [...(server.query.iterateLlmCallInput({ ...MAIN, llmCallId: "a3" }) ?? [])];
        expect(input.map((event) => event.eventId)).toEqual(["u1", "a1", "u2", "a2", "u3"]);
        expect(JSON.parse(input[0]?.body ?? "")).toEqual(user("u1", 1));
    });
});

describe("derived data rebuild", () => {
    async function seed() {
        const started = await start();
        const { server } = started;
        await sendTurn(server, "u1", [
            user("u1", 0),
            request("a1", 1, ["t1", "t2"], { usage: { input_tokens: 3 } }),
            result("r1", 2, "t1"),
            result("r2", 2.5, "t2", { subagent_id: "sub-1" }),
            compaction("c1", 3, "auto"),
            summary("cs1", 4, { usage: { output_tokens: 9 }, model: "small" }),
            final("a2", 5),
        ]);
        await sendTurn(server, "u2", [user("u2", 6), request("a3", 7, ["t3"])]);
        await sendTurn(server, "u3", [
            user("u3", 8),
            final("a4", 9, { error: { message: "x", will_retry: false } }),
        ]);
        await sendTurn(server, "su1", [user("su1", 1.5), final("sa1", 2.2)], {
            agentId: "sub-1",
            parentId: "main",
        });
        return started;
    }

    test("gives the same derived data as receiving the transport units", async () => {
        const { server, dataFile } = await seed();
        const before = snapshot(dataFile, DERIVED_TABLES);
        server.close();
        execute(dataFile, "UPDATE derivation SET version = 0");

        const reopened = await start(dataFile, { rebuildBatchSize: 1 });
        expect(snapshot(dataFile, DERIVED_TABLES)).toEqual(before);
        expect(snapshot(dataFile, ["derivation"])).toEqual({ derivation: [{ id: 1, version: 1 }] });
        expect(reopened.logs.map((log) => log.message)).toEqual([
            "rebuilding derived data",
            "rebuilt derived data",
        ]);
    });

    test("answers unavailable until the derived data is ready", async () => {
        const { server, dataFile } = await seed();
        server.close();
        execute(dataFile, "DELETE FROM derivation");

        const reopened = await start(dataFile, { rebuildBatchSize: 1, prepare: false });
        const next = unit("u4", 0, [user("u4", 10)]);
        expect(await reopened.server.receive(next)).toMatchObject({
            status: "rejected",
            retryable: true,
            error: { code: "unavailable", message: "derived data is not prepared yet" },
        });
        const preparing = reopened.server.prepare();
        expect(await reopened.server.receive(next)).toMatchObject({
            status: "rejected",
            retryable: true,
            error: { code: "unavailable", message: "derived data is being rebuilt" },
        });
        await preparing;
        expect((await reopened.server.receive(next)).status).toBe("accepted");
    });
});

describe("atomic writes", () => {
    test("a failure while deriving leaves nothing stored and answers unavailable", async () => {
        const dataFile = join(temporaryDirectory(), "agentoscope.db");
        const repository = openSqliteRepository({ path: dataFile, busyTimeoutMs: 1000 });
        // 파생 데이터를 만들다 실패하는 저장소입니다. 나머지는 원래 저장소에 그대로 맡깁니다.
        const failing = new Proxy(repository, {
            get(target, property) {
                if (property === "write") {
                    return <T>(work: (tx: WriteTransaction) => T): T =>
                        target.write((tx) =>
                            work({
                                ...tx,
                                replaceTurn: () => {
                                    throw new Error("derivation failed");
                                },
                            }),
                        );
                }
                const value: unknown = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as Repository;
        const logs: Log[] = [];
        const ingest = createIngestService({ repository: failing, logger: recordingLogger(logs) });
        await ingest.prepare();
        const adapter = createInputAdapter({ ingest, logger: recordingLogger(logs) });

        expect(await adapter.receive(unit("u1", 0, [user("u1", 0)]))).toMatchObject({
            status: "rejected",
            retryable: true,
            error: { code: "unavailable", message: "derivation failed" },
        });
        repository.close();
        expect(snapshot(dataFile, ["session", "agent", "ingest", "event", "turn"])).toEqual({
            session: [],
            agent: [],
            ingest: [],
            event: [],
            turn: [],
        });
    });
});

describe("Query API", () => {
    test("lists sessions by start time with filters", async () => {
        const { server } = await start();
        await sendTurn(server, "u1", [user("u1", 10)], { sessionId: "old", cwd: "/a", host: "h1" });
        await sendTurn(server, "u1", [user("u1", 20)], { sessionId: "new", cwd: "/b", host: "h1" });
        await sendTurn(server, "u1", [user("u1", 30)], {
            sessionId: "other-agent",
            agentKind: "opencode",
        });
        // Turn을 시작한 user_message가 없는 Session은 처음 받은 시각으로 정렬합니다.
        await server.receive(unit("lost", 1, [final("a1", 40)], { sessionId: "no-turn" }));

        const list = (filter: Record<string, string> = {}) =>
            server.query
                .listSessions({ limit: 10, offset: 0, ...filter })
                .map((session) => session.sessionId);
        expect(list()).toEqual(["no-turn", "other-agent", "new", "old"]);
        expect(list({ agentKind: "claude-code" })).toEqual(["no-turn", "new", "old"]);
        expect(list({ cwd: "/a" })).toEqual(["old"]);
        expect(list({ host: "h1" })).toEqual(["new", "old"]);
        expect(server.query.listSessions({ limit: 2, offset: 1 }).map((s) => s.sessionId)).toEqual([
            "other-agent",
            "new",
        ]);
        expect(
            server.query.listSessions({ limit: 10, offset: 0, agentKind: "opencode" })[0],
        ).toMatchObject({ agentCount: 1, turnCount: 1, startedAtUs: us(30), endedAtUs: us(30) });
    });

    test("lists LLM calls of a session by failure, stop reason and agent", async () => {
        const { server } = await start();
        const failure = {
            error: {
                message: "rate limited",
                code: "rate_limit_error",
                status_code: 429,
                will_retry: true,
            },
            attempt: 1,
            content: [],
            stop_reason: undefined,
        };
        await sendTurn(server, "u1", [
            user("u1", 0),
            final("a1", 1, failure),
            final("a2", 2, { attempt: 2, stop_reason: "max_tokens" }),
        ]);
        await sendTurn(server, "su1", [user("su1", 3), final("sa1", 4)], {
            agentId: "sub-1",
            parentId: "main",
        });

        const ids = (filter = {}) =>
            server.query.listLlmCalls(SESSION, filter)?.map((call) => `${call.agentId}/${call.id}`);
        expect(ids()).toEqual(["main/a1", "main/a2", "sub-1/sa1"]);
        expect(ids({ failed: true })).toEqual(["main/a1"]);
        expect(ids({ stopReason: "max_tokens" })).toEqual(["main/a2"]);
        expect(ids({ agentId: "sub-1" })).toEqual(["sub-1/sa1"]);
        expect(ids({ agentId: "nobody" })).toEqual([]);
        expect(server.query.listLlmCalls(SESSION, { failed: true })?.[0]).toMatchObject({
            failed: true,
            attempt: 1,
            error: {
                message: "rate limited",
                code: "rate_limit_error",
                statusCode: 429,
                willRetry: true,
            },
        });
    });

    test("returns compactions with their token usage in the turn", async () => {
        const { server } = await start();
        await sendTurn(server, "u1", [
            user("u1", 0),
            final("a1", 1, { usage: { input_tokens: 10 } }),
        ]);
        await sendTurn(server, "u2", [
            user("u2", 2, "/compact"),
            compaction("c1", 3, "manual"),
            summary("cs1", 4, { model: "small", usage: { input_tokens: 100, output_tokens: 7 } }),
        ]);
        const turn = server.query.getTurn({ ...MAIN, turnId: "u2" });
        expect(turn).toMatchObject({
            status: "completed",
            loops: [],
            compactionCount: 1,
            usage: { inputTokens: 100, outputTokens: 7 },
            compactions: [
                {
                    id: "c1",
                    turnId: "u2",
                    position: 1,
                    summaryEventId: "cs1",
                    trigger: "manual",
                    contextTokensBefore: 150_000,
                    model: "small",
                    startedAtUs: us(3),
                    endedAtUs: us(4),
                    usage: { inputTokens: 100, outputTokens: 7 },
                },
            ],
        });
        expect(server.query.getSession(SESSION)?.usage).toEqual({
            inputTokens: 110,
            outputTokens: 7,
        });
    });

    test("returns undefined for what does not exist", async () => {
        const { server } = await start();
        await sendTurn(server, "u1", [user("u1", 0)]);
        expect(server.query.getSession({ ...SESSION, sessionId: "nope" })).toBeUndefined();
        expect(server.query.listTurns({ ...MAIN, agentId: "nobody" })).toBeUndefined();
        expect(server.query.getTurn({ ...MAIN, turnId: "nope" })).toBeUndefined();
        expect(
            server.query.getToolCall({ ...MAIN, llmCallId: "nope", ordinal: 0 }),
        ).toBeUndefined();
        expect(server.query.getEventBody({ ...SESSION, eventId: "nope" })).toBeUndefined();
        expect(server.query.listLlmCalls({ ...SESSION, sessionId: "nope" })).toBeUndefined();
    });

    test("lists turns of an agent without event bodies", async () => {
        const { server } = await start();
        const long = "x".repeat(500);
        await sendTurn(server, "u1", [user("u1", 0, long), final("a1", 1)]);
        const [turn] = server.query.listTurns(MAIN) ?? [];
        expect(turn?.promptPreview).toBe("x".repeat(200));
        expect(turn?.promptLength).toBe(500);
        expect(JSON.stringify(server.query.getTurn({ ...MAIN, turnId: "u1" }))).not.toContain(
            "answer a1",
        );
    });
});

test("the Query API reads event bodies one row at a time", async () => {
    const { server } = await start();
    await sendTurn(server, "u1", [
        user("u1", 0),
        request("a1", 1, ["t1"]),
        result("r1", 2, "t1"),
        final("a2", 3),
    ]);
    // event.body를 .all()로 읽는 질의가 없는지, 모든 질의를 실행하며 확인합니다.
    // bun:sqlite는 Statement마다 all을 따로 두므로, 만들어지는 Statement의 all을 감쌉니다.
    const queries: string[] = [];
    const originals = new Map<
        { all: (...args: unknown[]) => unknown },
        (...args: unknown[]) => unknown
    >();
    const database = Database.prototype as unknown as Record<
        "query" | "prepare",
        (sql: string) => unknown
    >;
    const factories = { query: database.query, prepare: database.prepare };
    for (const name of ["query", "prepare"] as const) {
        const factory = factories[name];
        database[name] = function (this: unknown, sql: string) {
            const statement = factory.call(this, sql) as { all: (...args: unknown[]) => unknown };
            if (!originals.has(statement)) originals.set(statement, statement.all);
            const all = originals.get(statement) as (...args: unknown[]) => unknown;
            statement.all = (...args: unknown[]) => {
                queries.push(sql);
                return all.apply(statement, args);
            };
            return statement;
        };
    }
    try {
        server.query.listSessions({ limit: 10, offset: 0 });
        server.query.getSession(SESSION);
        server.query.listTurns(MAIN);
        server.query.getTurn({ ...MAIN, turnId: "u1" });
        server.query.listLlmCalls(SESSION);
        server.query.getToolCall({ ...MAIN, llmCallId: "a1", ordinal: 0 });
        [...(server.query.iterateLlmCallInput({ ...MAIN, llmCallId: "a2" }) ?? [])];
    } finally {
        database.query = factories.query;
        database.prepare = factories.prepare;
        for (const [statement, all] of originals) statement.all = all;
    }
    expect(queries.length).toBeGreaterThan(0);
    for (const sql of queries) {
        // body를 그대로 읽는 열은 없어야 합니다. JSON 함수로 작은 값만 꺼내는 것(body ->)은 괜찮습니다.
        expect(sql).not.toMatch(/(^|[\s,.(])body(?!\s*->)\b/);
    }
});
