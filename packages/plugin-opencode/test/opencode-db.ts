/**
 * 테스트용 OpenCode 1.19.x DB입니다. docs/003.reference/003.OPENCODE_SESSION_LOG.md의 기록 순서대로
 * `event`, `event_sequence`, `session` 행을 한 트랜잭션씩 씁니다.
 */

import { Database } from "bun:sqlite";

export const BASE_TIME = 1_793_194_597_000;

export interface ToolCall {
    readonly part: string;
    readonly call: string;
    readonly tool: string;
    readonly input: Record<string, unknown>;
    readonly output?: string;
    readonly error?: string;
    readonly metadata?: Record<string, unknown>;
}

export class FakeOpenCode {
    readonly db: Database;
    private counter = 0;
    private clock = BASE_TIME;

    constructor(readonly path: string) {
        this.db = new Database(path, { create: true });
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS session (id text PRIMARY KEY, parent_id text, directory text NOT NULL);
            CREATE TABLE IF NOT EXISTS event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text);
            CREATE TABLE IF NOT EXISTS event (
                id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL,
                type text NOT NULL, data text NOT NULL,
                FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE
            );
        `);
    }

    close(): void {
        this.db.close();
    }

    /** 다음 시각(밀리초)입니다. 기록할 때마다 1초씩 늘어납니다. */
    tick(): number {
        this.clock += 1000;
        return this.clock;
    }

    /** 이벤트 하나를 OpenCode처럼 한 트랜잭션으로 씁니다. 쓴 행의 id를 돌려줍니다. */
    event(session: string, type: string, data: Record<string, unknown>): string {
        const id = `evt_${String(++this.counter).padStart(6, "0")}`;
        this.db.transaction(() => {
            const row = this.db
                .query<{ seq: number }, [string]>(
                    "SELECT seq FROM event_sequence WHERE aggregate_id = ?",
                )
                .get(session);
            const seq = row === null ? 0 : row.seq + 1;
            this.db
                .query(
                    "INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, ?) ON CONFLICT DO UPDATE SET seq = excluded.seq",
                )
                .run(session, seq);
            this.db
                .query(
                    "INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)",
                )
                .run(id, session, seq, type, JSON.stringify({ sessionID: session, ...data }));
        })();
        return id;
    }

    session(id: string, options: { parent?: string; directory?: string } = {}): string {
        const directory = options.directory ?? "/work/project";
        this.db
            .query("INSERT INTO session (id, parent_id, directory) VALUES (?, ?, ?)")
            .run(id, options.parent ?? null, directory);
        return this.event(id, "session.created.1", {
            info: {
                id,
                directory,
                ...(options.parent ? { parentID: options.parent } : {}),
                time: { created: this.tick() },
            },
        });
    }

    /** session과 그 이벤트를 지웁니다. */
    deleteSession(id: string): void {
        this.db.query("DELETE FROM event_sequence WHERE aggregate_id = ?").run(id);
        this.db.query("DELETE FROM event WHERE aggregate_id = ?").run(id);
        this.db.query("DELETE FROM session WHERE id = ?").run(id);
    }

    userMessage(session: string, message: string): string {
        return this.event(session, "message.updated.1", {
            info: { id: message, sessionID: session, role: "user", time: { created: this.tick() } },
        });
    }

    part(session: string, part: Record<string, unknown>): string {
        return this.event(session, "message.part.updated.1", {
            part: { sessionID: session, ...part },
            time: this.tick(),
        });
    }

    /** 사용자 입력입니다. user message와 text part를 기록하고, text part 행의 id를 돌려줍니다. */
    user(
        session: string,
        message: string,
        text: string,
        options: { synthetic?: boolean } = {},
    ): string {
        this.userMessage(session, message);
        return this.part(session, {
            id: `prt_${message}_text`,
            messageID: message,
            type: "text",
            text,
            ...(options.synthetic ? { synthetic: true } : {}),
        });
    }

    assistantInfo(
        session: string,
        message: string,
        parent: string,
        extra: Record<string, unknown> = {},
    ): Record<string, unknown> {
        return {
            id: message,
            sessionID: session,
            role: "assistant",
            parentID: parent,
            modelID: "model-1",
            providerID: "provider",
            mode: "build",
            agent: "build",
            time: { created: BASE_TIME },
            ...extra,
        };
    }

    /** assistant message를 만듭니다. */
    assistant(
        session: string,
        message: string,
        parent: string,
        extra: Record<string, unknown> = {},
    ): string {
        return this.event(session, "message.updated.1", {
            info: this.assistantInfo(session, message, parent, extra),
        });
    }

    stepStart(session: string, message: string, part = `prt_${message}_start`): string {
        return this.part(session, { id: part, messageID: message, type: "step-start" });
    }

    /** text나 reasoning part를 시작과 끝 두 번 기록합니다. 끝 행의 id를 돌려줍니다. */
    text(
        session: string,
        message: string,
        part: string,
        text: string,
        type: "text" | "reasoning" = "text",
    ): string {
        const start = this.tick();
        this.part(session, { id: part, messageID: message, type, text: "", time: { start } });
        return this.part(session, {
            id: part,
            messageID: message,
            type,
            text,
            time: { start, end: this.tick() },
        });
    }

    toolPending(session: string, message: string, call: ToolCall): string {
        this.part(session, {
            id: call.part,
            messageID: message,
            type: "tool",
            callID: call.call,
            tool: call.tool,
            state: { status: "pending", input: {}, raw: "" },
        });
        return this.part(session, {
            id: call.part,
            messageID: message,
            type: "tool",
            callID: call.call,
            tool: call.tool,
            state: { status: "running", input: call.input, time: { start: BASE_TIME } },
        });
    }

    toolDone(session: string, message: string, call: ToolCall): string {
        const end = this.tick();
        return this.part(session, {
            id: call.part,
            messageID: message,
            type: "tool",
            callID: call.call,
            tool: call.tool,
            state:
                call.error === undefined
                    ? {
                          status: "completed",
                          input: call.input,
                          output: call.output ?? "",
                          title: call.tool,
                          metadata: call.metadata ?? {},
                          time: { start: BASE_TIME, end },
                      }
                    : {
                          status: "error",
                          input: call.input,
                          error: call.error,
                          ...(call.metadata ? { metadata: call.metadata } : {}),
                          time: { start: BASE_TIME, end },
                      },
        });
    }

    tool(session: string, message: string, call: ToolCall): string {
        this.toolPending(session, message, call);
        return this.toolDone(session, message, call);
    }

    stepFinish(
        session: string,
        message: string,
        reason: string,
        tokens: Record<string, unknown> = {
            total: 120,
            input: 100,
            output: 15,
            reasoning: 5,
            cache: { read: 30, write: 0 },
        },
    ): string {
        return this.part(session, {
            id: `prt_${message}_finish_${this.counter}`,
            messageID: message,
            type: "step-finish",
            reason,
            cost: 0,
            tokens,
        });
    }

    /** step이 끝난 뒤 assistant message에 finish와 time.completed를 채웁니다. */
    complete(session: string, message: string, parent: string, finish: string): string {
        this.event(session, "message.updated.1", {
            info: this.assistantInfo(session, message, parent, { finish }),
        });
        return this.event(session, "message.updated.1", {
            info: this.assistantInfo(session, message, parent, {
                finish,
                time: { created: BASE_TIME, completed: this.tick() },
            }),
        });
    }

    /** assistant message에 error를 채웁니다. */
    fail(
        session: string,
        message: string,
        parent: string,
        error: Record<string, unknown>,
        extra: Record<string, unknown> = {},
    ): string {
        return this.event(session, "message.updated.1", {
            info: this.assistantInfo(session, message, parent, {
                error,
                time: { created: BASE_TIME, completed: this.tick() },
                ...extra,
            }),
        });
    }

    /** LLM 호출 한 번을 OpenCode의 에이전트 루프 순서대로 기록합니다. step-finish 행의 id를 돌려줍니다. */
    step(
        session: string,
        message: string,
        parent: string,
        options: {
            text?: string;
            reasoning?: string;
            tools?: readonly ToolCall[];
            finish?: string;
        } = {},
    ): string {
        this.assistant(session, message, parent);
        this.stepStart(session, message);
        if (options.reasoning !== undefined) {
            this.text(session, message, `prt_${message}_reasoning`, options.reasoning, "reasoning");
        }
        if (options.text !== undefined) {
            this.text(session, message, `prt_${message}_text`, options.text);
        }
        for (const call of options.tools ?? []) this.toolPending(session, message, call);
        for (const call of options.tools ?? []) this.toolDone(session, message, call);
        const finish = options.finish ?? ((options.tools?.length ?? 0) > 0 ? "tool-calls" : "stop");
        const id = this.stepFinish(session, message, finish);
        this.complete(session, message, parent, finish);
        return id;
    }
}
