import { describe, expect, test } from "bun:test";
import { deriveTurn, type TurnEventRow } from "../src/derive";

const TURN_ID = "turn-1";
const START_US = 1_800_000_000_000_000;

interface RowOptions {
    readonly eventId?: string;
    readonly ingestId?: number;
    readonly timestampUs?: number;
}

function row(
    position: number,
    type: string,
    fields: Record<string, unknown> = {},
    options: RowOptions = {},
): TurnEventRow {
    const eventId = options.eventId ?? `e${position}`;
    return {
        eventId,
        position,
        type,
        timestampUs: options.timestampUs ?? START_US + position * 1_000_000,
        ingestId: options.ingestId ?? position + 1,
        body: JSON.stringify({ event_id: eventId, type, timestamp: "unused", ...fields }),
    };
}

const prompt = (options: RowOptions = {}) =>
    row(0, "user_message", { text: "fix the test" }, { eventId: TURN_ID, ...options });
const final = (position: number, fields: Record<string, unknown> = {}) =>
    row(position, "assistant_message", { content: [{ type: "text", text: "done" }], ...fields });
const toolRequest = (position: number, ...toolUseIds: string[]) =>
    row(position, "assistant_message", {
        content: toolUseIds.map((id) => ({
            type: "tool_use",
            tool_use_id: id,
            name: "read",
            input: { path: id },
        })),
        stop_reason: "tool_use",
    });
const toolResult = (position: number, toolUseId: string, fields: Record<string, unknown> = {}) =>
    row(position, "tool_result", { tool_use_id: toolUseId, output: "ok", ...fields });

function derive(...rows: TurnEventRow[]) {
    const result = deriveTurn(TURN_ID, rows);
    if (result === undefined) throw new Error("expected a turn");
    return result;
}

describe("deriveTurn", () => {
    test("needs the user_message that started the turn at position 0", () => {
        expect(deriveTurn(TURN_ID, [final(1)])).toBeUndefined();
        expect(
            deriveTurn(TURN_ID, [row(0, "user_message", { text: "x" }, { eventId: "other" })]),
        ).toBeUndefined();
        expect(deriveTurn(TURN_ID, [row(0, "assistant_message", { content: [] })])).toBeUndefined();
    });

    test("a turn with only its prompt is in progress", () => {
        const { turn } = derive(prompt({ ingestId: 7 }));
        expect(turn).toMatchObject({
            turnId: TURN_ID,
            status: "in_progress",
            startedAtUs: START_US,
            endedAtUs: START_US,
            ingestId: 7,
        });
        expect(turn.llmCalls).toEqual([]);
    });

    test("a final response completes the turn", () => {
        const { turn } = derive(prompt(), final(1, { model: "m", stop_reason: "end_turn" }));
        expect(turn.status).toBe("completed");
        expect(turn.endedAtUs).toBe(START_US + 1_000_000);
        expect(turn.llmCalls).toEqual([
            {
                id: "e1",
                position: 1,
                model: "m",
                stopReason: "end_turn",
                failed: false,
                startedAtUs: START_US,
                startedAtEstimated: true,
                endedAtUs: START_US + 1_000_000,
            },
        ]);
        expect(turn.toolCalls).toEqual([]);
    });

    test("a turn waiting for or after a tool result is in progress", () => {
        expect(derive(prompt(), toolRequest(1, "t1")).turn.status).toBe("in_progress");
        const { turn } = derive(prompt(), toolRequest(1, "t1"), toolResult(2, "t1"));
        expect(turn.status).toBe("in_progress");
        expect(turn.endedAtUs).toBe(START_US + 2_000_000);
    });

    test("turn_interrupted interrupts the turn", () => {
        const { turn } = derive(prompt(), toolRequest(1, "t1"), row(2, "turn_interrupted"));
        expect(turn.status).toBe("interrupted");
    });

    test("an LLM call error without retry stops the turn as errored", () => {
        const { turn } = derive(
            prompt(),
            row(1, "assistant_message", {
                content: [{ type: "tool_use", tool_use_id: "t1", name: "read", input: {} }],
                error: { message: "overloaded", will_retry: false },
            }),
        );
        expect(turn.status).toBe("errored");
        expect(turn.llmCalls[0]?.failed).toBe(true);
        // 오류로 끝난 LLM Call의 Loop에는 Tool Call이 없습니다.
        expect(turn.toolCalls).toEqual([]);
    });

    test("an LLM call error with retry keeps the turn going", () => {
        const failed = row(1, "assistant_message", {
            content: [],
            error: { message: "rate limited", will_retry: true },
            attempt: 1,
        });
        expect(derive(prompt(), failed).turn.status).toBe("in_progress");
        const { turn } = derive(prompt(), failed, final(2, { attempt: 2 }));
        expect(turn.status).toBe("completed");
        expect(turn.llmCalls.map((call) => [call.failed, call.attempt])).toEqual([
            [true, 1],
            [false, 2],
        ]);
    });

    test("a manual compaction summary completes the turn, an auto one does not", () => {
        const manual = derive(
            prompt(),
            row(1, "compaction", { trigger: "manual" }),
            row(2, "compaction_summary", { text: "summary" }),
        );
        expect(manual.turn.status).toBe("completed");
        const auto = derive(
            prompt(),
            row(1, "compaction", { trigger: "auto" }),
            row(2, "compaction_summary", { text: "summary" }),
        );
        expect(auto.turn.status).toBe("in_progress");
    });

    test("pairs a compaction with the summary right after it", () => {
        const { turn } = derive(
            prompt(),
            row(1, "compaction", { trigger: "auto", context_tokens_before: 180_000 }),
            row(2, "compaction", { trigger: "auto" }),
            row(3, "compaction_summary", {
                text: "summary",
                model: "small",
                usage: { input_tokens: 10, output_tokens: 2 },
            }),
            row(4, "compaction_summary", { text: "orphan" }),
        );
        expect(turn.compactions).toEqual([
            {
                id: "e1",
                position: 1,
                trigger: "auto",
                contextTokensBefore: 180_000,
                startedAtUs: START_US + 1_000_000,
            },
            {
                id: "e2",
                position: 2,
                trigger: "auto",
                startedAtUs: START_US + 2_000_000,
                summaryEventId: "e3",
                endedAtUs: START_US + 3_000_000,
                model: "small",
                usage: { inputTokens: 10, outputTokens: 2 },
            },
        ]);
    });

    test("pairs tool results first in, first out by tool_use_id and ignores orphans", () => {
        const { turn } = derive(
            prompt(),
            toolRequest(1, "a", "b"),
            toolResult(2, "b", { is_error: true }),
            toolResult(3, "zzz"),
            toolResult(4, "a", { subagent_id: "sub-1" }),
            toolRequest(5, "a"),
            toolResult(6, "a"),
        );
        expect(turn.toolCalls).toEqual([
            {
                llmCallId: "e1",
                ordinal: 0,
                toolUseId: "a",
                name: "read",
                startedAtUs: START_US + 1_000_000,
                resultEventId: "e4",
                endedAtUs: START_US + 4_000_000,
                subagentId: "sub-1",
            },
            {
                llmCallId: "e1",
                ordinal: 1,
                toolUseId: "b",
                name: "read",
                startedAtUs: START_US + 1_000_000,
                resultEventId: "e2",
                endedAtUs: START_US + 2_000_000,
                isError: true,
            },
            {
                llmCallId: "e5",
                ordinal: 0,
                toolUseId: "a",
                name: "read",
                startedAtUs: START_US + 5_000_000,
                resultEventId: "e6",
                endedAtUs: START_US + 6_000_000,
            },
        ]);
    });

    test("uses the recorded started_at or estimates it from the previous known event", () => {
        const { turn } = derive(
            prompt(),
            row(1, "future_event", {}),
            toolRequest(2, "t1"),
            toolResult(3, "t1"),
            final(4, { started_at: "2027-01-15T08:00:03.250000Z" }),
        );
        expect(turn.llmCalls.map((call) => [call.startedAtUs, call.startedAtEstimated])).toEqual([
            [START_US, true],
            [Date.UTC(2027, 0, 15, 8, 0, 3) * 1000 + 250_000, false],
        ]);
    });

    test("ignores unknown event types for the activity model but not for receipt order", () => {
        const result = derive(
            prompt({ ingestId: 5 }),
            final(1),
            row(2, "future_event", {}, { ingestId: 3 }),
        );
        expect(result.turn.status).toBe("completed");
        expect(result.turn.endedAtUs).toBe(START_US + 1_000_000);
        expect(result.firstIngestId).toBe(2);
    });

    test("keeps unrecorded usage absent and drops invalid values", () => {
        const { turn } = derive(
            prompt(),
            toolRequest(1, "t1"),
            toolResult(2, "t1"),
            final(3, {
                usage: { input_tokens: 5, output_tokens: -1, cache_read_tokens: 1.5 },
                stop_reason: "something_else",
                attempt: 0,
            }),
        );
        expect(turn.llmCalls[0]?.usage).toBeUndefined();
        expect(turn.llmCalls[1]?.usage).toEqual({ inputTokens: 5 });
        expect(turn.llmCalls[1]?.stopReason).toBeUndefined();
        expect(turn.llmCalls[1]?.attempt).toBeUndefined();
    });

    test("does not build models from events at position 0", () => {
        const { turn } = derive(prompt(), row(0, "assistant_message", { content: [] }));
        expect(turn.llmCalls).toEqual([]);
    });
});
