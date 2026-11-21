/**
 * OpenCode DB의 `event` 테이블을 session마다 저장한 위치 다음부터 읽어 변환하고 Transport Unit으로 넘깁니다.
 * docs/002.implementation/006.plugin/003.opencode/001.OVERVIEW.md의 "Session Log"를 따릅니다.
 */

import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import type { PluginLogger, PluginTransportUnit } from "@agentoscope/plugin-api";
import {
    type AgentState,
    type ConvertDeps,
    convert,
    type EventRow,
    newAgentState,
} from "./convert";
import { type PluginState, saveState } from "./state";

/** 한 번에 읽는 `event` 행의 수입니다. 읽기 트랜잭션을 짧게 유지합니다. */
export const DEFAULT_BATCH_SIZE = 100;
/** parentID를 따라 올라가는 최대 깊이입니다. */
const MAX_DEPTH = 64;

interface Identity {
    readonly sessionId: string;
    readonly parentId?: string;
    readonly cwd?: string;
}

export interface CollectorOptions {
    readonly dbPath: string;
    readonly statePath: string;
    readonly state: PluginState;
    readonly submit: (unit: PluginTransportUnit) => void;
    readonly logger: PluginLogger;
    readonly batchSize?: number;
    /** 수집을 멈춰야 하면 true를 돌려줍니다. */
    readonly stopping: () => boolean;
}

export interface Collector {
    /** 저장한 위치 다음부터 각 session의 `event_sequence` 값까지 수집합니다. */
    collect(): Promise<void>;
    close(): void;
}

export function createCollector(options: CollectorOptions): Collector {
    const { logger, state } = options;
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    let db: Database | undefined;
    let inode: number | undefined;
    const identities = new Map<string, Identity>();
    /** 같은 문제를 주기마다 되풀이해 기록하지 않도록 마지막으로 기록한 문제입니다. */
    let reported: string | undefined;
    const unresolved = new Set<string>();

    function report(problem: string | undefined, details?: Record<string, string>): void {
        if (problem === reported) return;
        reported = problem;
        if (problem !== undefined) logger.warn(problem, { db: options.dbPath, ...details });
    }

    function closeDb(): void {
        db?.close();
        db = undefined;
        inode = undefined;
        identities.clear();
    }

    /** DB를 읽기 전용으로 엽니다. 파일이 다른 파일로 바뀌었으면 다시 엽니다. 파일이 없으면 undefined입니다. */
    function open(): Database | undefined {
        let ino: number;
        try {
            ino = statSync(options.dbPath).ino;
        } catch {
            closeDb();
            report("the OpenCode database does not exist yet");
            return undefined;
        }
        if (db !== undefined && inode === ino) return db;
        closeDb();
        try {
            db = new Database(options.dbPath, { readonly: true });
            inode = ino;
        } catch (error) {
            closeDb();
            report("cannot open the OpenCode database", { message: String(error) });
            return undefined;
        }
        return db;
    }

    function resolve(connection: Database, aggregate: string): Identity | undefined {
        const cached = identities.get(aggregate);
        if (cached !== undefined) return cached;
        const query = connection.query<
            { parent_id: string | null; directory: string | null },
            [string]
        >("SELECT parent_id, directory FROM session WHERE id = ?");
        const own = query.get(aggregate);
        if (own === null) return undefined;
        let root = aggregate;
        let parent = own.parent_id;
        for (let depth = 0; parent !== null; depth++) {
            if (depth >= MAX_DEPTH) return undefined;
            const row = query.get(parent);
            if (row === null) return undefined;
            root = parent;
            parent = row.parent_id;
        }
        const identity: Identity = {
            sessionId: root,
            ...(own.parent_id === null ? {} : { parentId: own.parent_id }),
            ...(own.directory ? { cwd: own.directory } : {}),
        };
        identities.set(aggregate, identity);
        return identity;
    }

    function deps(connection: Database, aggregate: string): ConvertDeps {
        return {
            stepParts(fromSeq, toSeq, messageId) {
                const parts = new Map<string, unknown>();
                const rows = connection
                    .query<{ data: string }, [string, number, number]>(
                        `SELECT data FROM event
                         WHERE aggregate_id = ? AND seq > ? AND seq < ? AND type = 'message.part.updated.1'
                         ORDER BY seq`,
                    )
                    .iterate(aggregate, fromSeq, toSeq);
                for (const row of rows) {
                    let part: { id?: unknown; messageID?: unknown } | undefined;
                    try {
                        part = (JSON.parse(row.data) as { part?: typeof part }).part;
                    } catch {
                        continue;
                    }
                    if (part?.messageID !== messageId || typeof part.id !== "string") continue;
                    // Map은 처음 넣은 순서를 유지하므로 part를 만든 순서가 됩니다.
                    parts.set(part.id, part);
                }
                return [...parts.values()];
            },
        };
    }

    function save(): void {
        try {
            saveState(options.statePath, state);
        } catch (error) {
            logger.error("cannot save the collection state", { message: String(error) });
        }
    }

    async function collectSession(
        connection: Database,
        aggregate: string,
        upTo: number,
        session: AgentState,
    ): Promise<void> {
        const identity = resolve(connection, aggregate);
        if (identity === undefined) {
            if (!unresolved.has(aggregate)) {
                unresolved.add(aggregate);
                logger.info("waiting until the session and its parent sessions are recorded", {
                    sessionId: aggregate,
                });
            }
            return;
        }
        unresolved.delete(aggregate);
        const read = connection.query<EventRow, [string, number, number, number]>(
            `SELECT id, seq, type, data FROM event
             WHERE aggregate_id = ? AND seq > ? AND seq <= ?
             ORDER BY seq LIMIT ?`,
        );
        const convertDeps = deps(connection, aggregate);
        for (;;) {
            const rows = read.all(aggregate, session.seq, upTo, batchSize);
            for (const row of rows) {
                if (options.stopping()) return;
                const conversion = convert(row, session, convertDeps);
                if (conversion.kind === "unit") {
                    options.submit({
                        session: {
                            id: identity.sessionId,
                            ...(identity.cwd === undefined ? {} : { cwd: identity.cwd }),
                        },
                        agent: {
                            id: aggregate,
                            ...(identity.parentId === undefined
                                ? {}
                                : { parent_id: identity.parentId }),
                        },
                        turn: conversion.turn,
                        events: conversion.events,
                    });
                } else if (conversion.kind === "invalid") {
                    logger.warn("skipped an OpenCode record that cannot be interpreted", {
                        sessionId: aggregate,
                        eventId: row.id,
                        seq: row.seq,
                        type: row.type,
                        reason: conversion.reason,
                    });
                }
                session.seq = row.seq;
            }
            save();
            if (rows.length < batchSize) return;
            // 다른 일(Transport Unit 전송 등)이 이어서 실행될 수 있게 이벤트 루프에 양보합니다.
            await Bun.sleep(0);
        }
    }

    return {
        async collect() {
            const connection = open();
            if (connection === undefined) return;
            const hasEvents = connection
                .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event'")
                .get();
            if (hasEvents === null) {
                report("the OpenCode database has no event table");
                return;
            }
            report(undefined);

            const latest = new Map(
                connection
                    .query<{ aggregate_id: string; seq: number }, []>(
                        "SELECT aggregate_id, seq FROM event_sequence",
                    )
                    .all()
                    .map((row) => [row.aggregate_id, row.seq]),
            );
            let changed = false;
            for (const id of Object.keys(state.sessions)) {
                if (!latest.has(id)) {
                    // session이 지워졌습니다.
                    delete state.sessions[id];
                    identities.delete(id);
                    changed = true;
                }
            }
            if (changed) save();

            for (const [aggregate, upTo] of latest) {
                if (options.stopping()) return;
                let session = state.sessions[aggregate];
                if (session === undefined || session.seq > upTo) {
                    // 처음 보는 session이거나, 저장한 위치가 DB보다 앞서 있어 처음부터 다시 수집합니다.
                    session = newAgentState();
                    state.sessions[aggregate] = session;
                }
                if (session.seq >= upTo) continue;
                await collectSession(connection, aggregate, upTo, session);
            }
        },
        close() {
            closeDb();
        },
    };
}
