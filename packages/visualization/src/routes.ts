import { timingSafeEqual } from "node:crypto";
import type { QueryApi } from "@alm/core";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { SpaBundle } from "./spa-bundle";

const COOKIE = "alm_token";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface VisualizationOptions {
  readonly query: QueryApi;
  readonly spa: SpaBundle;
  /** 시작할 때 만든 접근 토큰입니다. */
  readonly token: string;
  /** 바인딩한 주소입니다(예: "127.0.0.1:41234"). 다른 Host 헤더는 거절합니다. */
  readonly host: () => string;
}

function sameToken(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

function pageSize(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

function nonNegative(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function json(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "application/json" } });
}

/** 본문을 한 줄씩 NDJSON으로 스트리밍합니다. 여러 본문을 메모리에 모으지 않습니다. */
function streamLines(lines: Iterable<string>): Response {
  const iterator = lines[Symbol.iterator]();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(`${next.value}\n`));
    },
    cancel() {
      iterator.return?.();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
}

function html(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agentic Loop Monitoring</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="/assets/app.js"></script>
</body>
</html>
`;
}

/** Query API를 JSON으로 내주는 Hono 라우트입니다. Persistence에 직접 접근하지 않습니다. */
export function createVisualizationApp(options: VisualizationOptions): Hono {
  const { query, spa, token } = options;
  const app = new Hono();

  app.use("*", async (context, next) => {
    if (context.req.header("host") !== options.host()) {
      return context.text("forbidden", 403);
    }
    const url = new URL(context.req.url);
    const offered = url.searchParams.get("token");
    if (offered !== null) {
      if (!sameToken(token, offered)) return context.text("unauthorized", 401);
      setCookie(context, COOKIE, token, { httpOnly: true, sameSite: "Strict", path: "/" });
      return context.redirect("/", 302);
    }
    if (!sameToken(token, getCookie(context, COOKIE))) {
      deleteCookie(context, COOKIE);
      return context.text("unauthorized", 401);
    }
    await next();
  });

  app.get("/", (context) => context.html(html()));
  app.get("/assets/app.js", (context) => {
    context.header("Content-Type", "text/javascript; charset=utf-8");
    return context.body(spa.js);
  });
  app.get("/assets/app.css", (context) => {
    context.header("Content-Type", "text/css; charset=utf-8");
    return context.body(spa.css);
  });

  app.get("/api/sessions", (context) => {
    const { agent, cwd, host, limit, offset } = context.req.query();
    return context.json(
      query.listSessions({
        limit: pageSize(limit),
        offset: nonNegative(offset),
        ...(agent ? { agent } : {}),
        ...(cwd ? { cwd } : {}),
        ...(host ? { host } : {}),
      }),
    );
  });

  app.get("/api/sessions/:agent/:id", (context) => {
    const session = query.getSession(context.req.param("agent"), context.req.param("id"));
    return session ? context.json(session) : context.notFound();
  });

  app.delete("/api/sessions/:agent/:id", (context) => {
    const deleted = query.deleteSession(context.req.param("agent"), context.req.param("id"));
    return deleted ? context.body(null, 204) : context.notFound();
  });

  app.get("/api/agents/:pk/turns", (context) => {
    return context.json(query.listTurns(Number(context.req.param("pk"))));
  });

  app.get("/api/agents/:pk/turns/:turnId", (context) => {
    const turn = query.getTurn(Number(context.req.param("pk")), context.req.param("turnId"));
    return turn ? context.json(turn) : context.notFound();
  });

  app.get("/api/agents/:pk/llm-calls/:id/input", (context) => {
    const lines = query.iterateLlmCallInput(
      Number(context.req.param("pk")),
      context.req.param("id"),
    );
    return lines ? streamLines(lines) : context.notFound();
  });

  app.get("/api/agents/:pk/events/:id", (context) => {
    const body = query.getEventBody(Number(context.req.param("pk")), context.req.param("id"));
    return body === undefined ? context.notFound() : json(body);
  });

  app.get("/api/agents/:pk/tool-calls/:llmCallId/:ordinal", (context) => {
    const body = query.getToolCallBody(
      Number(context.req.param("pk")),
      context.req.param("llmCallId"),
      Number(context.req.param("ordinal")),
    );
    return body ? context.json(body) : context.notFound();
  });

  return app;
}
