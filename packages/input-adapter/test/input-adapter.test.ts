import { describe, expect, test } from "bun:test";
import {
    type IngestApi,
    type IngestRequest,
    type Logger,
    UnavailableError,
} from "@agentoscope/core";
import type { TransportUnit } from "@agentoscope/plugin-api";
import { createInputAdapter } from "../src";

interface Log {
    readonly level: "info" | "warn" | "error";
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>> | undefined;
}

function setup(onIngest: (request: IngestRequest) => void = () => {}) {
    const requests: IngestRequest[] = [];
    const logs: Log[] = [];
    const logger: Logger = {
        info: (message, details) => logs.push({ level: "info", message, details }),
        warn: (message, details) => logs.push({ level: "warn", message, details }),
        error: (message, details) => logs.push({ level: "error", message, details }),
    };
    const ingest: IngestApi = {
        ingest(request) {
            requests.push(request);
            onIngest(request);
            return {
                storedCount: request.events.length,
                droppedCount: request.eventCount - request.events.length,
            };
        },
    };
    return { adapter: createInputAdapter({ ingest, logger }), requests, logs };
}

const TIMESTAMP = "2026-11-20T01:00:00Z";
const TIMESTAMP_US = Date.UTC(2026, 10, 20, 1, 0, 0) * 1000;

const userMessage = { event_id: "u1", type: "user_message", timestamp: TIMESTAMP, text: "hi" };

function unit(overrides: Record<string, unknown> = {}): TransportUnit {
    return {
        protocol_version: 1,
        transport_unit_id: "tu-1",
        source: { agent: "claude-code", plugin_version: "0.1.0", host: "laptop" },
        session: { id: "s1", cwd: "/work" },
        agent: { id: "main" },
        turn: { id: "u1", position: 0 },
        events: [userMessage],
        ...overrides,
    } as TransportUnit;
}

const assistant = (fields: Record<string, unknown> = {}) => ({
    event_id: "a1",
    type: "assistant_message",
    timestamp: TIMESTAMP,
    content: [{ type: "text", text: "ok" }],
    ...fields,
});

describe("receive", () => {
    test("accepts a valid transport unit and passes it to the Ingest API", async () => {
        const { adapter, requests } = setup();
        const ack = await adapter.receive(unit());
        expect(ack).toEqual({ protocol_version: 1, transport_unit_id: "tu-1", status: "accepted" });
        expect(requests).toEqual([
            {
                protocolVersion: 1,
                transportUnitId: "tu-1",
                source: { agentKind: "claude-code", pluginVersion: "0.1.0", host: "laptop" },
                session: { id: "s1", cwd: "/work" },
                agent: { id: "main" },
                turn: { id: "u1", position: 0 },
                eventCount: 1,
                events: [
                    {
                        index: 0,
                        eventId: "u1",
                        type: "user_message",
                        timestampUs: TIMESTAMP_US,
                        body: JSON.stringify(userMessage),
                    },
                ],
            },
        ]);
    });

    test("keeps unknown fields, event types and content blocks in the body", async () => {
        const { adapter, requests } = setup();
        const events = [
            { ...assistant(), content: [{ type: "image", data: "..." }], future_field: { a: 1 } },
            { event_id: "x1", type: "system_prompt", timestamp: TIMESTAMP, text: "be nice" },
        ];
        const ack = await adapter.receive(
            unit({
                turn: { id: "u1", position: 1 },
                agent: { id: "sub", parent_id: "main" },
                events,
            }),
        );
        expect(ack.status).toBe("accepted");
        expect(requests[0]?.agent).toEqual({ id: "sub", parentId: "main" });
        expect(requests[0]?.events.map((event) => JSON.parse(event.body))).toEqual(events);
    });

    test("rejects input that is not a transport unit object", async () => {
        const { adapter, logs } = setup();
        for (const value of [null, "text", [unit()]]) {
            expect(await adapter.receive(value as unknown as TransportUnit)).toEqual({
                protocol_version: 1,
                transport_unit_id: "",
                status: "rejected",
                retryable: false,
                error: {
                    code: "invalid_transport_unit",
                    message: "transport unit must be a JSON object",
                },
            });
        }
        expect(logs.map((log) => log.level)).toEqual(["warn", "warn", "warn"]);
    });

    test("rejects a transport unit without a required field", async () => {
        const { adapter, requests } = setup();
        const cases = [
            unit({ session: { cwd: "/work" } }),
            unit({ source: { agent: "claude-code" } }),
            unit({ turn: { id: "u1", position: -1 } }),
            unit({
                turn: { id: "u1", position: Number.MAX_SAFE_INTEGER },
                events: [userMessage, userMessage],
            }),
            unit({ events: [] }),
            unit({ transport_unit_id: "" }),
            unit({ agent: { id: "sub", parent_id: null } }),
        ];
        for (const value of cases) {
            const ack = await adapter.receive(value);
            expect(ack).toMatchObject({
                status: "rejected",
                retryable: false,
                error: { code: "invalid_transport_unit" },
            });
        }
        expect(requests).toEqual([]);
    });

    test("checks protocol_version before the version 1 format", async () => {
        const { adapter } = setup();
        expect(
            await adapter.receive({
                protocol_version: 2,
                transport_unit_id: "tu-9",
            } as unknown as TransportUnit),
        ).toEqual({
            protocol_version: 1,
            transport_unit_id: "tu-9",
            status: "rejected",
            retryable: true,
            error: { code: "unsupported_version", message: "protocol_version 2 is not supported" },
        });
        for (const version of [undefined, "1", 1.5]) {
            const ack = await adapter.receive(unit({ protocol_version: version }));
            expect(ack).toMatchObject({
                retryable: false,
                error: { code: "invalid_transport_unit" },
            });
        }
    });

    test("drops only invalid events and keeps the positions of the rest", async () => {
        const { adapter, requests, logs } = setup();
        const events = [
            userMessage,
            assistant({ event_id: "a1", stop_reason: "bogus" }),
            {
                event_id: "r1",
                type: "tool_result",
                timestamp: TIMESTAMP,
                tool_use_id: "t",
                output: [1],
            },
            assistant({ event_id: "a2", usage: { input_tokens: 2 ** 60 } }),
            assistant({ event_id: "a3", started_at: "yesterday" }),
            { event_id: "u2", type: "user_message", timestamp: "2026-02-30T00:00:00Z", text: "x" },
            assistant({
                event_id: "a4",
                content: [{ type: "tool_use", tool_use_id: "t1", name: "read", input: ["a"] }],
            }),
            "not an object",
            assistant({ event_id: "a5", attempt: 2, error: { message: "rate", will_retry: true } }),
        ];
        const ack = await adapter.receive(unit({ events }));
        expect(ack.status).toBe("accepted");
        expect(requests[0]?.eventCount).toBe(9);
        expect(requests[0]?.events.map((event) => [event.index, event.eventId])).toEqual([
            [0, "u1"],
            [8, "a5"],
        ]);
        const dropped = logs.filter(
            (log) => log.message === "dropped an invalid session log event",
        );
        expect(dropped.map((log) => [log.details?.index, log.details?.eventId])).toEqual([
            [1, "a1"],
            [2, "r1"],
            [3, "a2"],
            [4, "a3"],
            [5, "u2"],
            [6, "a4"],
            [7, null],
        ]);
    });

    test("drops an event that cannot be serialized", async () => {
        const { adapter, requests } = setup();
        const ack = await adapter.receive(
            unit({ events: [userMessage, { ...assistant(), extra: 10n }] }),
        );
        expect(ack.status).toBe("accepted");
        expect(requests[0]?.events.map((event) => event.eventId)).toEqual(["u1"]);
    });

    test("answers unavailable when the Ingest API cannot store the transport unit", async () => {
        const rebuilding = setup(() => {
            throw new UnavailableError("rebuilding");
        });
        expect(await rebuilding.adapter.receive(unit())).toEqual({
            protocol_version: 1,
            transport_unit_id: "tu-1",
            status: "rejected",
            retryable: true,
            error: { code: "unavailable", message: "derived data is being rebuilt" },
        });
        expect(rebuilding.logs.map((log) => log.level)).toEqual(["info"]);

        const broken = setup(() => {
            throw new Error("disk I/O error");
        });
        expect(await broken.adapter.receive(unit())).toMatchObject({
            status: "rejected",
            retryable: true,
            error: { code: "unavailable", message: "disk I/O error" },
        });
        expect(broken.logs.map((log) => log.level)).toEqual(["error"]);
    });
});
