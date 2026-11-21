import { describe, expect, test } from "bun:test";
import type { Ack, TransportUnit } from "@agentoscope/plugin-api";
import { createSender, type Transport } from "../src";
import { type Log, pluginUnit, recordingLogger } from "./support";

const SOURCE = { agent: "opencode", pluginVersion: "1.2.3" };
const RETRY = { count: 2, intervalMs: 5, maxIntervalMs: 20 };

function accepted(unit: TransportUnit): Ack {
    return { protocol_version: 1, transport_unit_id: unit.transport_unit_id, status: "accepted" };
}

function rejected(unit: TransportUnit, retryable: boolean): Ack {
    return {
        protocol_version: 1,
        transport_unit_id: unit.transport_unit_id,
        status: "rejected",
        retryable,
        error: { code: retryable ? "unavailable" : "invalid_transport_unit", message: "no" },
    };
}

function idCounter(): () => string {
    let next = 0;
    return () => `tu-${++next}`;
}

async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("timed out");
        await Bun.sleep(2);
    }
}

describe("sender", () => {
    test("sends units one at a time in order and fills the daemon fields", async () => {
        const sent: TransportUnit[] = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const transport: Transport = async (unit) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Bun.sleep(3);
            sent.push(unit);
            inFlight--;
            return accepted(unit);
        };
        const logs: Log[] = [];
        const sender = createSender({
            transport,
            ackTimeoutMs: 1000,
            retry: RETRY,
            host: "box",
            logger: recordingLogger(logs),
            newId: idCounter(),
        });
        const first = pluginUnit("t1");
        sender.enqueue(SOURCE, first);
        sender.enqueue({ agent: "codex", pluginVersion: "0.1.0" }, pluginUnit("t2"));
        sender.enqueue(SOURCE, pluginUnit("t3"));
        expect(sender.pending).toBe(3);
        await until(() => sent.length === 3);

        expect(maxInFlight).toBe(1);
        expect(sent.map((unit) => unit.turn.id)).toEqual(["t1", "t2", "t3"]);
        expect(sent[0]).toEqual({
            ...first,
            protocol_version: 1,
            transport_unit_id: "tu-1",
            source: { agent: "opencode", plugin_version: "1.2.3", host: "box" },
        });
        // 프로세스 내 호출에서는 events를 복사하지 않고 넘깁니다.
        expect(sent[0]?.events).toBe(first.events);
        expect(sent[1]?.source.agent).toBe("codex");
        expect(logs).toEqual([]);
        await sender.close(100);
    });

    test("retries retryable failures with a new transport unit id, then gives up", async () => {
        const ids: string[] = [];
        let calls = 0;
        const transport: Transport = async (unit) => {
            ids.push(unit.transport_unit_id);
            calls++;
            if (calls === 1) throw new Error("connection refused");
            if (calls === 2) return rejected(unit, true);
            if (calls === 3) return new Promise<Ack>(() => {}); // Ack가 오지 않습니다.
            if (calls === 4) return { ...accepted(unit), transport_unit_id: "someone else" };
            return accepted(unit);
        };
        const logs: Log[] = [];
        const sender = createSender({
            transport,
            ackTimeoutMs: 20,
            retry: { count: 3, intervalMs: 1, maxIntervalMs: 4 },
            logger: recordingLogger(logs),
            newId: idCounter(),
        });
        sender.enqueue(SOURCE, pluginUnit("t1"));
        sender.enqueue(SOURCE, pluginUnit("t2"));
        await until(() => calls === 5);
        await until(() => sender.pending === 0);

        expect(ids).toEqual(["tu-1", "tu-2", "tu-3", "tu-4", "tu-5"]);
        expect(logs.map((log) => [log.level, log.message])).toEqual([
            ["warn", "transport failed"],
            ["warn", "transport unit rejected"],
            ["warn", "ack timed out"],
            ["warn", "ack does not answer the transport unit"],
            ["error", "dropped a transport unit after all retries failed"],
        ]);
        expect(logs[4]?.details).toMatchObject({ turnId: "t1", attempts: 4 });
        await sender.close(100);
    });

    test("drops units the main server rejects as not retryable", async () => {
        const turns: string[] = [];
        const transport: Transport = async (unit) => {
            turns.push(unit.turn.id);
            return unit.turn.id === "bad" ? rejected(unit, false) : accepted(unit);
        };
        const logs: Log[] = [];
        const sender = createSender({
            transport,
            ackTimeoutMs: 100,
            retry: RETRY,
            logger: recordingLogger(logs),
        });
        sender.enqueue(SOURCE, pluginUnit("bad"));
        sender.enqueue(SOURCE, pluginUnit("good"));
        await until(() => turns.length === 2);
        expect(turns).toEqual(["bad", "good"]);
        expect(logs.map((log) => [log.level, log.message, log.details?.code])).toEqual([
            [
                "error",
                "dropped a transport unit the main server rejected",
                "invalid_transport_unit",
            ],
        ]);
        await sender.close(100);
    });

    test("sends what it can before closing and drops the rest", async () => {
        let release: () => void = () => {};
        const sent: string[] = [];
        const transport: Transport = async (unit) => {
            if (unit.turn.id === "slow") await new Promise<void>((resolve) => (release = resolve));
            sent.push(unit.turn.id);
            return accepted(unit);
        };
        const logs: Log[] = [];
        const sender = createSender({
            transport,
            ackTimeoutMs: 1000,
            retry: RETRY,
            logger: recordingLogger(logs),
        });
        sender.enqueue(SOURCE, pluginUnit("fast"));
        await until(() => sent.length === 1);
        sender.enqueue(SOURCE, pluginUnit("slow"));
        sender.enqueue(SOURCE, pluginUnit("never"));
        await sender.close(30);
        release();
        sender.enqueue(SOURCE, pluginUnit("late"));
        await Bun.sleep(10);

        expect(sent).toEqual(["fast", "slow"]);
        expect(logs.map((log) => log.message)).toEqual([
            "dropped transport units that were not sent before the daemon stopped",
            "ignored a transport unit submitted after the daemon stopped",
        ]);
    });

    test("closes at once when nothing is waiting", async () => {
        const sender = createSender({
            transport: async (unit) => accepted(unit),
            ackTimeoutMs: 100,
            retry: RETRY,
            logger: recordingLogger([]),
        });
        const started = Date.now();
        await sender.close(5000);
        expect(Date.now() - started).toBeLessThan(1000);
    });
});
