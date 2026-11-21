import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WriteTransaction } from "@agentoscope/core";
import {
    MIGRATIONS,
    openSqliteRepository,
    SCHEMA_V1,
    type SqliteRepository,
    UnsupportedSchemaError,
} from "../src";

const DOC = join(import.meta.dir, "../../../docs/002.implementation/009.TABLE_DEFINITION.md");

const directories: string[] = [];
const repositories: SqliteRepository[] = [];

afterEach(() => {
    for (const repository of repositories.splice(0)) repository.close();
    for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
});

function temporaryPath(): string {
    const directory = mkdtempSync(join(tmpdir(), "agentoscope-persistence-"));
    directories.push(directory);
    return join(directory, "data", "agentoscope.db");
}

function open(path = temporaryPath(), busyTimeoutMs = 1000): SqliteRepository {
    const repository = openSqliteRepository({ path, busyTimeoutMs });
    repositories.push(repository);
    return repository;
}

/** Session, Agent, 수신 기록을 만들고 Session Log Event를 저장합니다. */
function addEvents(
    tx: WriteTransaction,
    turnId: string,
    events: readonly { position: number; type: string; eventId?: string }[],
) {
    const session = tx.ensureSession("claude-code", "s1");
    const agent = tx.ensureAgent(session.pk, "main");
    const ingestId = tx.addIngest({
        transportUnitId: "tu",
        protocolVersion: 1,
        pluginVersion: "0.1.0",
        sessionPk: session.pk,
        agentPk: agent.pk,
        receivedAtUs: 1,
        eventCount: events.length,
        droppedCount: 0,
    });
    for (const event of events) {
        const eventId = event.eventId ?? `${turnId}:${event.position}`;
        tx.addEvent({
            sessionPk: session.pk,
            agentPk: agent.pk,
            eventId,
            turnId,
            position: event.position,
            type: event.type,
            timestampUs: event.position,
            body: JSON.stringify({ event_id: eventId, type: event.type }),
            ingestId,
        });
    }
    return { sessionPk: session.pk, agentPk: agent.pk };
}

describe("schema", () => {
    test("version 1 is the DDL of 009.TABLE_DEFINITION.md", async () => {
        const doc = await Bun.file(DOC).text();
        const ddl = /```sql\n([\s\S]*?)\n```/.exec(doc)?.[1];
        expect(SCHEMA_V1).toBe(ddl ?? "");
        expect(MIGRATIONS).toEqual([SCHEMA_V1]);
    });
});

describe("openSqliteRepository", () => {
    test("creates the data directory as 0700 and applies the settings", () => {
        const path = temporaryPath();
        const repository = open(path, 1234);
        expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
        expect(repository.settings()).toEqual({
            journalMode: "wal",
            synchronous: 2,
            foreignKeys: 1,
            busyTimeoutMs: 1234,
            mmapSize: 0,
        });
    });

    test("migrates to the latest schema version once", () => {
        const path = temporaryPath();
        open(path).close();
        open(path).close();
        const db = new Database(path, { readonly: true });
        expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
        expect(
            db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get(),
        ).toEqual({
            n: 10,
        });
        db.close();
    });

    test("refuses a database newer than the code", () => {
        const path = temporaryPath();
        open(path).close();
        const db = new Database(path);
        db.exec("PRAGMA user_version = 99");
        db.close();
        expect(() => open(path)).toThrow(UnsupportedSchemaError);
    });
});

describe("write", () => {
    test("rolls back everything when the work throws", () => {
        const repository = open();
        expect(() =>
            repository.write((tx) => {
                addEvents(tx, "t1", [{ position: 0, type: "user_message" }]);
                throw new Error("boom");
            }),
        ).toThrow("boom");
        expect(
            repository.findSession({ agentKind: "claude-code", sessionId: "s1" }),
        ).toBeUndefined();
    });

    test("skips an event whose event_id is already stored in the session", () => {
        const repository = open();
        repository.write((tx) => {
            const { sessionPk, agentPk } = addEvents(tx, "t1", [
                { position: 0, type: "user_message" },
            ]);
            const again = tx.addEvent({
                sessionPk,
                agentPk,
                eventId: "t1:0",
                turnId: "other",
                position: 5,
                type: "assistant_message",
                timestampUs: 0,
                body: "{}",
                ingestId: 1,
            });
            expect(again).toBe(false);
        });
    });

    test("fails when the write lock is not released within the busy timeout", () => {
        const path = temporaryPath();
        const repository = open(path, 50);
        const other = new Database(path);
        other.exec("BEGIN IMMEDIATE");
        try {
            expect(() => repository.write(() => undefined)).toThrow();
        } finally {
            other.exec("ROLLBACK");
            other.close();
        }
        expect(repository.write(() => "ok")).toBe("ok");
    });

    test("lets another connection read while a write transaction is open", () => {
        const path = temporaryPath();
        const repository = open(path);
        repository.write((tx) => {
            addEvents(tx, "t1", [{ position: 0, type: "user_message" }]);
            const reader = new Database(path, { readonly: true });
            expect(reader.query("SELECT COUNT(*) AS n FROM event").get()).toEqual({ n: 0 });
            reader.close();
        });
    });
});

describe("iterateEvents", () => {
    test("reads segments in order, within their positions, and only the given types", () => {
        const repository = open();
        const { agentPk } = repository.write((tx) => {
            addEvents(tx, "t1", [
                { position: 0, type: "user_message" },
                { position: 1, type: "assistant_message" },
                { position: 2, type: "future_event" },
                { position: 3, type: "tool_result" },
            ]);
            return addEvents(tx, "t2", [
                { position: 0, type: "user_message" },
                { position: 1, type: "assistant_message" },
            ]);
        });
        const events = [
            ...repository.iterateEvents(
                agentPk,
                [
                    { turnId: "t2", fromPosition: 0, toPosition: 1 },
                    { turnId: "t1", fromPosition: 1 },
                ],
                ["user_message", "assistant_message", "tool_result"],
            ),
        ];
        expect(events.map((event) => event.eventId)).toEqual(["t2:0", "t1:1", "t1:3"]);
        expect(JSON.parse(events[1]?.body ?? "{}")).toEqual({
            event_id: "t1:1",
            type: "assistant_message",
        });
    });

    test("can stop early and still lets the database close", () => {
        const repository = open();
        const { agentPk } = repository.write((tx) =>
            addEvents(tx, "t1", [
                { position: 0, type: "user_message" },
                { position: 1, type: "assistant_message" },
            ]),
        );
        for (const event of repository.iterateEvents(
            agentPk,
            [{ turnId: "t1", fromPosition: 0 }],
            ["user_message", "assistant_message"],
        )) {
            expect(event.position).toBe(0);
            break;
        }
        expect(repository.write(() => "still writable")).toBe("still writable");
    });
});
