/**
 * Visualization의 Hono 라우트입니다(docs/002.implementation/011.VISUALIZATION.md).
 * 라우트마다 Query API의 메서드 하나를 불러 결과를 JSON으로 돌려주며, Persistence에 직접 접근하지 않습니다.
 */

import { timingSafeEqual } from "node:crypto";
import type { InputEvent, Logger, QueryApi } from "@agentoscope/core";
import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";

/** 접근 토큰을 담는 쿠키의 이름입니다. */
export const TOKEN_COOKIE = "agentoscope_token";
/** 접근 토큰을 받아 쿠키를 주는 경로입니다. */
export const LOGIN_PATH = "/login";
/** Session 목록을 한 번에 불러오는 기본 수입니다. */
export const DEFAULT_SESSION_PAGE_SIZE = 50;

export interface RoutesOptions {
    readonly query: QueryApi;
    /** 접근 토큰입니다. */
    readonly token: string;
    /** 바인딩한 주소입니다(예: 127.0.0.1:43123). Host 헤더가 이와 다른 요청은 거절합니다. */
    readonly host: () => string;
    readonly logger: Logger;
}

type Env = { Variables: Record<string, never> };

/** Visualization의 Hono 앱을 만듭니다. Bun.serve의 fetch에 붙입니다. */
export function createRoutes(options: RoutesOptions): Hono<Env> {
    const { query, logger } = options;
    const expected = Buffer.from(options.token);
    const tokenMatches = (value: string | undefined): boolean => {
        if (value === undefined) return false;
        const given = Buffer.from(value);
        return given.length === expected.length && timingSafeEqual(given, expected);
    };

    const app = new Hono<Env>();

    // DNS rebinding을 막기 위해 바인딩한 주소로 온 요청만 받습니다.
    app.use(async (c, next) => {
        if (c.req.header("host") !== options.host()) return c.text("Forbidden", 403);
        await next();
        c.header("Cache-Control", "no-store");
        c.header("X-Content-Type-Options", "nosniff");
    });

    // URL의 토큰으로 처음 접속하면 쿠키를 주고 토큰이 없는 URL로 보냅니다.
    app.get(LOGIN_PATH, (c) => {
        if (!tokenMatches(c.req.query("token"))) return c.text("Unauthorized", 401);
        setCookie(c, TOKEN_COOKIE, options.token, {
            path: "/",
            httpOnly: true,
            sameSite: "Strict",
        });
        return c.redirect("/", 303);
    });

    app.use("/api/*", async (c, next) => {
        if (!tokenMatches(getCookie(c, TOKEN_COOKIE)))
            return c.json({ error: "unauthorized" }, 401);
        await next();
    });

    app.get("/api/sessions", (c) => {
        const limit = integerParam(c.req.query("limit"), DEFAULT_SESSION_PAGE_SIZE);
        const offset = integerParam(c.req.query("offset"), 0);
        if (limit === undefined || offset === undefined || limit < 1) {
            return c.json({ error: "limit and offset must be non-negative integers" }, 400);
        }
        const agentKind = nonEmpty(c.req.query("agent"));
        const cwd = nonEmpty(c.req.query("cwd"));
        const host = nonEmpty(c.req.query("host"));
        return c.json(
            query.listSessions({
                limit,
                offset,
                ...(agentKind === undefined ? {} : { agentKind }),
                ...(cwd === undefined ? {} : { cwd }),
                ...(host === undefined ? {} : { host }),
            }),
        );
    });

    const SESSION = "/api/sessions/:agentKind/:sessionId";
    const AGENT = `${SESSION}/agents/:agentId`;
    const LLM_CALL = `${AGENT}/llm-calls/:llmCallId`;

    app.get(SESSION, (c) => found(c, query.getSession(c.req.param())));

    app.get(`${AGENT}/turns`, (c) => found(c, query.listTurns(c.req.param())));

    app.get(`${AGENT}/turns/:turnId/nodes`, (c) => found(c, query.getTurnNodes(c.req.param())));

    app.get(`${LLM_CALL}/input`, (c) => {
        const events = query.iterateLlmCallInput(c.req.param());
        if (events === undefined) return c.json({ error: "not found" }, 404);
        return new Response(inputStream(events, logger), {
            headers: {
                "Content-Type": "application/x-ndjson; charset=utf-8",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        });
    });

    app.get(`${LLM_CALL}/tool-calls/:ordinal`, (c) => {
        const { ordinal, ...ref } = c.req.param();
        const value = integerParam(ordinal, undefined);
        if (value === undefined) return c.json({ error: "not found" }, 404);
        return found(c, query.getToolCall({ ...ref, ordinal: value }));
    });

    app.get(`${SESSION}/events/:eventId`, (c) => {
        const body = query.getEventBody(c.req.param());
        if (body === undefined) return c.json({ error: "not found" }, 404);
        return c.body(body, 200, { "Content-Type": "application/json; charset=utf-8" });
    });

    app.notFound((c) => c.json({ error: "not found" }, 404));
    app.onError((error, c) => {
        logger.error("visualization request failed", {
            path: c.req.path,
            message: error instanceof Error ? error.message : String(error),
        });
        return c.json({ error: "internal error" }, 500);
    });
    return app;
}

function found(c: Context<Env>, value: unknown) {
    return value === undefined ? c.json({ error: "not found" }, 404) : c.json(value);
}

function nonEmpty(value: string | undefined): string | undefined {
    return value === undefined || value === "" ? undefined : value;
}

/** 음이 아닌 정수 문자열을 읽습니다. 값이 없으면 fallback을, 정수가 아니면 undefined를 돌려줍니다. */
function integerParam(value: string | undefined, fallback: number | undefined): number | undefined {
    if (value === undefined || value === "") return fallback;
    if (!/^\d{1,9}$/.test(value)) return undefined;
    return Number(value);
}

/**
 * LLM Call의 input을 한 줄에 Session Log Event 하나씩 NDJSON으로 보냅니다. 본문은 한 행씩 읽어 바로 보내며,
 * 여러 본문을 모으지 않습니다. 저장된 본문은 JSON이므로 다시 직렬화하지 않고 그대로 붙입니다.
 * 브라우저가 연결을 끊으면 읽기를 닫습니다.
 */
function inputStream(events: Iterable<InputEvent>, logger: Logger): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let iterator: Iterator<InputEvent> | undefined;
    const close = () => {
        const current = iterator;
        iterator = undefined;
        current?.return?.();
    };
    return new ReadableStream<Uint8Array>(
        {
            start() {
                iterator = events[Symbol.iterator]();
            },
            pull(controller) {
                try {
                    const next = iterator?.next();
                    if (next === undefined || next.done) {
                        iterator = undefined;
                        controller.close();
                        return;
                    }
                    const { body, ...meta } = next.value;
                    const head = JSON.stringify(meta);
                    controller.enqueue(
                        encoder.encode(
                            `${head.slice(0, -1)},"size":${body.length},"body":${body}}\n`,
                        ),
                    );
                } catch (error) {
                    close();
                    logger.error("cannot read the LLM Call input", {
                        message: error instanceof Error ? error.message : String(error),
                    });
                    controller.error(error);
                }
            },
            cancel() {
                close();
            },
        },
        { highWaterMark: 0 },
    );
}
