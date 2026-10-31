import { describe, expect, test } from "bun:test";
import type { QueryApi } from "@alm/core";
import { createVisualizationApp } from "../src/routes";

const HOST = "127.0.0.1:1234";
const TOKEN = "secret-token";

const query = {
  listSessions: () => [{ id: "s1" }],
  iterateLlmCallInput: () => ['{"a":1}', '{"b":2}'],
} as unknown as QueryApi;

const app = createVisualizationApp({
  query,
  spa: { js: "js", css: "css" },
  token: TOKEN,
  host: () => HOST,
});

function request(path: string, headers: Record<string, string> = {}) {
  return app.request(`http://${HOST}${path}`, { headers: { host: HOST, ...headers } });
}

const cookie = { cookie: `alm_token=${TOKEN}` };

describe("access", () => {
  test("rejects requests without a token", async () => {
    expect((await request("/")).status).toBe(401);
    expect((await request("/api/sessions")).status).toBe(401);
    expect((await request("/assets/app.js")).status).toBe(401);
  });

  test("rejects a wrong token and a wrong Host", async () => {
    expect((await request(`/?token=wrong`)).status).toBe(401);
    expect((await request("/", { ...cookie, host: "evil.test" })).status).toBe(403);
    expect((await request(`/?token=${TOKEN}`, { host: "evil.test" })).status).toBe(403);
  });

  test("exchanges the URL token for a cookie and strips it from the URL", async () => {
    const response = await request(`/?token=${TOKEN}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });

  test("serves the SPA and the API with the cookie", async () => {
    expect((await request("/", cookie)).status).toBe(200);
    expect(await (await request("/assets/app.js", cookie)).text()).toBe("js");
    expect(await (await request("/api/sessions", cookie)).json()).toEqual([{ id: "s1" }]);
  });
});

describe("large bodies", () => {
  test("streams the input one event per line", async () => {
    const response = await request("/api/agents/1/llm-calls/x/input", cookie);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await response.text()).toBe('{"a":1}\n{"b":2}\n');
  });
});
