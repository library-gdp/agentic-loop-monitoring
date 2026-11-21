import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import {
    CONNECTION_FILE,
    loginUrl,
    readConnection,
    startVisualizationServer,
    type VisualizationServer,
} from "../src";
import {
    cleanUp,
    final,
    recordingLogger,
    request,
    result,
    sendTurn,
    start,
    temporaryDirectory,
    user,
} from "./support";

const servers: VisualizationServer[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop();
    cleanUp();
});

async function serve() {
    const { server } = await start();
    await sendTurn(
        server,
        "u/1",
        [
            user("u/1", 0, "Fix the flaky test"),
            request("a1", 1, ["t1"]),
            result("r1", 2, "t1"),
            final("a2", 3),
        ],
        { sessionId: "s/1", agentId: "main/agent" },
    );
    const stateDirectory = join(temporaryDirectory(), "state");
    const visualization = startVisualizationServer({
        query: server.query,
        port: 0,
        stateDirectory,
        logger: recordingLogger([]),
    });
    servers.push(visualization);
    const connection = readConnection(stateDirectory);
    if (connection === undefined) throw new Error("no connection file");
    const cookie = await login(loginUrl(connection));
    const get = (path: string, headers: Record<string, string> = {}) =>
        fetch(new URL(path, visualization.url), {
            headers: { cookie, ...headers },
            redirect: "manual",
        });
    return { visualization, stateDirectory, connection, cookie, get };
}

async function login(url: string): Promise<string> {
    const response = await fetch(url, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    return setCookie.split(";")[0] ?? "";
}

const SESSION = `/api/sessions/claude-code/${encodeURIComponent("s/1")}`;
const AGENT = `${SESSION}/agents/${encodeURIComponent("main/agent")}`;

describe("visualization server", () => {
    test("binds to 127.0.0.1 and writes the connection file as 0600", async () => {
        const { visualization, stateDirectory, connection } = await serve();
        expect(visualization.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        expect(connection.url).toBe(visualization.url);
        expect(connection.token).toMatch(/^[\w-]{43}$/);
        expect(statSync(join(stateDirectory, CONNECTION_FILE)).mode & 0o777).toBe(0o600);
        expect(statSync(stateDirectory).mode & 0o777).toBe(0o700);

        await visualization.stop();
        expect(readConnection(stateDirectory)).toBeUndefined();
    });

    test("serves the SPA", async () => {
        const { get } = await serve();
        const response = await get("/");
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('<div id="app">');
    });

    test("refuses requests without the token or with another Host", async () => {
        const { visualization, get, connection } = await serve();
        expect((await fetch(new URL("/api/sessions", visualization.url))).status).toBe(401);
        expect(
            (
                await fetch(new URL("/api/sessions", visualization.url), {
                    headers: { cookie: "agentoscope_token=wrong" },
                })
            ).status,
        ).toBe(401);
        expect((await fetch(new URL("/login?token=wrong", visualization.url))).status).toBe(401);
        expect((await get("/api/sessions", { host: "evil.example:80" })).status).toBe(403);
        const rebinding = await fetch(
            new URL(`/login?token=${connection.token}`, visualization.url),
            { headers: { host: "evil.example" }, redirect: "manual" },
        );
        expect(rebinding.status).toBe(403);
    });

    test("answers each route with the Query API", async () => {
        const { get } = await serve();
        const sessions = (await (await get("/api/sessions?limit=10")).json()) as unknown[];
        expect(sessions).toMatchObject([{ agentKind: "claude-code", sessionId: "s/1" }]);
        expect((await get("/api/sessions?limit=x")).status).toBe(400);
        expect((await get("/api/sessions?limit=0")).status).toBe(400);
        expect((await get("/api/sessions?agent=opencode")).json()).resolves.toEqual([]);

        expect(await (await get(SESSION)).json()).toMatchObject({
            sessionId: "s/1",
            agents: [{ agentId: "main/agent" }],
        });
        expect(await (await get(`${AGENT}/turns`)).json()).toMatchObject([
            { turnId: "u/1", status: "completed", loopCount: 2 },
        ]);
        const nodes = (await (
            await get(`${AGENT}/turns/${encodeURIComponent("u/1")}/nodes`)
        ).json()) as { nodes: { kind: string }[] };
        expect(nodes.nodes.map((node) => node.kind)).toEqual(["prompt", "llm_call", "llm_call"]);
        expect(await (await get(`${AGENT}/llm-calls/a1/tool-calls/0`)).json()).toMatchObject({
            toolUseId: "t1",
            input: { path: "/src/t1.ts" },
            output: "contents of t1",
        });
        const event = await get(`${SESSION}/events/a2`);
        expect(event.headers.get("content-type")).toContain("application/json");
        expect(await event.json()).toMatchObject({ event_id: "a2", type: "assistant_message" });

        for (const path of [
            "/api/sessions/claude-code/nope",
            `${SESSION}/agents/nobody/turns`,
            `${AGENT}/turns/nope/nodes`,
            `${AGENT}/llm-calls/a1/tool-calls/9`,
            `${AGENT}/llm-calls/a1/tool-calls/-1`,
            `${AGENT}/llm-calls/nope/input`,
            `${SESSION}/events/nope`,
            "/api/unknown",
        ]) {
            expect({ path, status: (await get(path)).status }).toEqual({ path, status: 404 });
        }
    });

    test("streams the LLM Call input one event per line", async () => {
        const { get } = await serve();
        const response = await get(`${AGENT}/llm-calls/a2/input`);
        expect(response.headers.get("content-type")).toContain("application/x-ndjson");
        const lines = (await response.text()).trim().split("\n");
        const items = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(items.map((item) => item.eventId)).toEqual(["u/1", "a1", "r1"]);
        expect(items[0]).toMatchObject({
            turnId: "u/1",
            position: 0,
            type: "user_message",
            body: { text: "Fix the flaky test" },
        });
        expect(items[0]?.size).toBeGreaterThan(0);
    });
});

test("binds to the configured port", async () => {
    const { server } = await start();
    // 빈 포트를 하나 얻어 그 포트로 시작합니다.
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port;
    await probe.stop(true);
    const visualization = startVisualizationServer({
        query: server.query,
        port: port ?? 0,
        stateDirectory: temporaryDirectory(),
        logger: recordingLogger([]),
    });
    servers.push(visualization);
    expect(visualization.url).toBe(`http://127.0.0.1:${port}/`);
});
