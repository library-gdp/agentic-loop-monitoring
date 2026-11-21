import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@agentoscope/core";
import type { TransportUnit } from "@agentoscope/plugin-api";
import { type MainServer, openMainServer } from "../src";

export interface Log {
    readonly level: "info" | "warn" | "error";
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>> | undefined;
}

export function recordingLogger(logs: Log[]): Logger {
    return {
        info: (message, details) => logs.push({ level: "info", message, details }),
        warn: (message, details) => logs.push({ level: "warn", message, details }),
        error: (message, details) => logs.push({ level: "error", message, details }),
    };
}

const cleanups: (() => void)[] = [];

/** 테스트가 끝나면 열린 Main Server를 닫고 임시 디렉터리를 지웁니다. afterEach에서 부릅니다. */
export function cleanUp(): void {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
}

export function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "agentoscope-app-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
}

export interface Started {
    readonly server: MainServer;
    readonly dataFile: string;
    readonly logs: Log[];
}

/** Main Server를 열고 파생 데이터를 준비합니다. */
export async function start(
    dataFile = join(temporaryDirectory(), "data", "agentoscope.db"),
    options: { readonly rebuildBatchSize?: number; readonly prepare?: boolean } = {},
): Promise<Started> {
    const logs: Log[] = [];
    let now = CLOCK_START_US;
    const server = openMainServer({
        dataFile,
        busyTimeoutMs: 1000,
        logger: recordingLogger(logs),
        now: () => {
            now += 1;
            return now;
        },
        ...(options.rebuildBatchSize === undefined
            ? {}
            : { rebuildBatchSize: options.rebuildBatchSize }),
    });
    cleanups.push(() => server.close());
    if (options.prepare !== false) await server.prepare();
    return { server, dataFile, logs };
}

// ── Transport Unit 만들기 ─────────────────────────────────────────────

const BASE_MS = Date.UTC(2026, 10, 20, 0, 0, 0);

/** 기준 시각에서 seconds초 뒤의 RFC 3339 시각입니다. */
export function at(seconds: number): string {
    return new Date(BASE_MS + seconds * 1000).toISOString();
}

/** at(seconds)를 마이크로초로 나타낸 값입니다. */
export function us(seconds: number): number {
    return (BASE_MS + seconds * 1000) * 1000;
}

/** Main Server가 Transport Unit을 받은 시각입니다. 테스트의 Session Log Event보다 늦습니다. */
export const CLOCK_START_US = us(1000);

export interface UnitOptions {
    readonly agentKind?: string;
    readonly sessionId?: string;
    readonly agentId?: string;
    readonly parentId?: string;
    readonly cwd?: string;
    readonly host?: string;
    readonly transportUnitId?: string;
}

let unitCounter = 0;

/** 레코드 하나에서 나온 Session Log Event를 담은 Transport Unit입니다. */
export function unit(
    turnId: string,
    position: number,
    events: readonly Record<string, unknown>[],
    options: UnitOptions = {},
): TransportUnit {
    unitCounter += 1;
    return {
        protocol_version: 1,
        transport_unit_id: options.transportUnitId ?? `tu-${unitCounter}`,
        source: {
            agent: options.agentKind ?? "claude-code",
            plugin_version: "0.1.0",
            ...(options.host === undefined ? {} : { host: options.host }),
        },
        session: {
            id: options.sessionId ?? "s1",
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        },
        agent: {
            id: options.agentId ?? "main",
            ...(options.parentId === undefined ? {} : { parent_id: options.parentId }),
        },
        turn: { id: turnId, position },
        events,
    } as unknown as TransportUnit;
}

export const user = (id: string, seconds: number, text = `prompt ${id}`) => ({
    event_id: id,
    type: "user_message",
    timestamp: at(seconds),
    text,
});

export const final = (id: string, seconds: number, fields: Record<string, unknown> = {}) => ({
    event_id: id,
    type: "assistant_message",
    timestamp: at(seconds),
    model: "model-a",
    content: [{ type: "text", text: `answer ${id}` }],
    stop_reason: "end_turn",
    ...fields,
});

export const request = (
    id: string,
    seconds: number,
    toolUseIds: readonly string[],
    fields: Record<string, unknown> = {},
) => ({
    event_id: id,
    type: "assistant_message",
    timestamp: at(seconds),
    model: "model-a",
    content: [
        { type: "reasoning", text: `thinking ${id}` },
        ...toolUseIds.map((toolUseId) => ({
            type: "tool_use",
            tool_use_id: toolUseId,
            name: "read",
            input: { path: `/src/${toolUseId}.ts` },
        })),
    ],
    stop_reason: "tool_use",
    ...fields,
});

export const result = (
    id: string,
    seconds: number,
    toolUseId: string,
    fields: Record<string, unknown> = {},
) => ({
    event_id: id,
    type: "tool_result",
    timestamp: at(seconds),
    tool_use_id: toolUseId,
    output: `contents of ${toolUseId}`,
    ...fields,
});

export const compaction = (id: string, seconds: number, trigger: "auto" | "manual") => ({
    event_id: id,
    type: "compaction",
    timestamp: at(seconds),
    trigger,
    context_tokens_before: 150_000,
});

export const summary = (id: string, seconds: number, fields: Record<string, unknown> = {}) => ({
    event_id: id,
    type: "compaction_summary",
    timestamp: at(seconds),
    text: `summary ${id}`,
    ...fields,
});

export const interrupted = (id: string, seconds: number) => ({
    event_id: id,
    type: "turn_interrupted",
    timestamp: at(seconds),
});

/** Turn 하나의 레코드를 레코드마다 Transport Unit 하나로 보냅니다. 모두 accepted여야 합니다. */
export async function sendTurn(
    server: MainServer,
    turnId: string,
    events: readonly Record<string, unknown>[],
    options: UnitOptions & { readonly from?: number } = {},
): Promise<void> {
    const from = options.from ?? 0;
    for (const [offset, event] of events.entries()) {
        const ack = await server.receive(unit(turnId, from + offset, [event], options));
        if (ack.status !== "accepted") throw new Error(`rejected: ${JSON.stringify(ack)}`);
    }
}

// ── 저장된 데이터 ──────────────────────────────────────────────────────

export const DERIVED_TABLES = ["turn", "llm_call", "tool_call", "compaction"] as const;
export const SOURCE_TABLES = ["session", "agent", "event"] as const;

/** 테이블의 모든 행을 순서와 상관없이 비교할 수 있게 정렬해 읽습니다. */
export function snapshot(
    dataFile: string,
    tables: readonly string[],
): Record<string, readonly unknown[]> {
    const db = new Database(dataFile, { readonly: true });
    try {
        return Object.fromEntries(
            tables.map((table) => {
                const rows = db
                    .query(`SELECT * FROM ${table}`)
                    .all()
                    .map((row) => JSON.stringify(row))
                    .sort();
                return [table, rows.map((row) => JSON.parse(row) as unknown)];
            }),
        );
    } finally {
        db.close();
    }
}

/** 다른 연결로 SQL을 실행합니다. 저장된 데이터를 일부러 바꿀 때 씁니다. */
export function execute(dataFile: string, sql: string): void {
    const db = new Database(dataFile);
    try {
        db.exec(sql);
    } finally {
        db.close();
    }
}
