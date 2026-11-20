import { describe, expect, test } from "bun:test";
import { compareTurns } from "../src/turn-order";
import { addUsage, sumUsage, usageFromEvent } from "../src/usage";

describe("compareTurns", () => {
    test("orders by started_at, then by the receipt order of the turn", () => {
        const turns = [
            { turnId: "c", startedAtUs: 20, ingestId: 1 },
            { turnId: "b", startedAtUs: 10, ingestId: 9 },
            { turnId: "a", startedAtUs: 10, ingestId: 4 },
            { turnId: "d", startedAtUs: 20, ingestId: 1 },
        ];
        expect([...turns].sort(compareTurns).map((turn) => turn.turnId)).toEqual([
            "a",
            "b",
            "c",
            "d",
        ]);
    });
});

describe("token usage", () => {
    test("reads recorded fields and drops invalid ones", () => {
        expect(
            usageFromEvent({
                input_tokens: 3,
                output_tokens: 0,
                cache_read_tokens: -1,
                reasoning_tokens: "2",
            }),
        ).toEqual({ inputTokens: 3, outputTokens: 0 });
        expect(usageFromEvent({})).toBeUndefined();
        expect(usageFromEvent(undefined)).toBeUndefined();
    });

    test("adds field by field and keeps unrecorded fields absent", () => {
        expect(addUsage({ inputTokens: 1 }, { inputTokens: 2, outputTokens: 5 })).toEqual({
            inputTokens: 3,
            outputTokens: 5,
        });
        expect(sumUsage([undefined, { cacheReadTokens: 7 }, {}])).toEqual({ cacheReadTokens: 7 });
        expect(sumUsage([])).toEqual({});
    });
});
