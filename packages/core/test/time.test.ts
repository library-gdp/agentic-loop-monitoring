import { describe, expect, test } from "bun:test";
import { parseTimestampUs } from "../src/time";

const utcUs = (...args: [number, number, number, number, number, number]) =>
    Date.UTC(...args) * 1000;

describe("parseTimestampUs", () => {
    test("reads UTC timestamps in microseconds", () => {
        expect(parseTimestampUs("2026-11-20T01:02:03Z")).toBe(utcUs(2026, 10, 20, 1, 2, 3));
        expect(parseTimestampUs("2026-11-20t01:02:03z")).toBe(utcUs(2026, 10, 20, 1, 2, 3));
    });

    test("keeps fractions down to microseconds", () => {
        const base = utcUs(2026, 10, 20, 1, 2, 3);
        expect(parseTimestampUs("2026-11-20T01:02:03.5Z")).toBe(base + 500_000);
        expect(parseTimestampUs("2026-11-20T01:02:03.123456Z")).toBe(base + 123_456);
        expect(parseTimestampUs("2026-11-20T01:02:03.1234569Z")).toBe(base + 123_456);
    });

    test("applies the offset", () => {
        expect(parseTimestampUs("2026-11-20T10:02:03+09:00")).toBe(utcUs(2026, 10, 20, 1, 2, 3));
        expect(parseTimestampUs("2026-11-19T20:32:03-04:30")).toBe(utcUs(2026, 10, 20, 1, 2, 3));
    });

    test("checks calendar dates", () => {
        expect(parseTimestampUs("2024-02-29T00:00:00Z")).toBe(utcUs(2024, 1, 29, 0, 0, 0));
        expect(parseTimestampUs("2023-02-29T00:00:00Z")).toBeUndefined();
        expect(parseTimestampUs("2026-04-31T00:00:00Z")).toBeUndefined();
        expect(parseTimestampUs("2026-13-01T00:00:00Z")).toBeUndefined();
        expect(parseTimestampUs("2026-11-20T24:00:00Z")).toBeUndefined();
    });

    test("rejects other formats", () => {
        expect(parseTimestampUs("2026-11-20 01:02:03Z")).toBeUndefined();
        expect(parseTimestampUs("2026-11-20T01:02:03")).toBeUndefined();
        expect(parseTimestampUs("2026-11-20T01:02:03+0900")).toBeUndefined();
        expect(parseTimestampUs("1763600523")).toBeUndefined();
    });

    test("reads early years inside the safe range", () => {
        expect(parseTimestampUs("1900-01-01T00:00:00Z")).toBe(utcUs(1900, 0, 1, 0, 0, 0));
    });

    test("rejects timestamps outside the safe integer range", () => {
        expect(parseTimestampUs("9999-12-31T23:59:59Z")).toBeUndefined();
        expect(parseTimestampUs("0050-01-01T00:00:00Z")).toBeUndefined();
    });
});
