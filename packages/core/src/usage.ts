import { isRecord, type Mutable, nonNegativeInteger } from "./json";
import type { TokenUsage } from "./model";

/** Token Usage의 항목입니다. */
export const TOKEN_FIELDS = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
] as const satisfies readonly (keyof TokenUsage)[];

const WIRE_NAMES = {
    inputTokens: "input_tokens",
    outputTokens: "output_tokens",
    cacheReadTokens: "cache_read_tokens",
    cacheWriteTokens: "cache_write_tokens",
    reasoningTokens: "reasoning_tokens",
} as const satisfies Record<(typeof TOKEN_FIELDS)[number], string>;

/**
 * Session Log Event의 usage 객체를 Token Usage로 옮깁니다. 0 이상의 안전한 정수가 아닌 항목은 뺍니다.
 * 기록된 항목이 하나도 없으면 undefined입니다.
 */
export function usageFromEvent(value: unknown): TokenUsage | undefined {
    if (!isRecord(value)) return undefined;
    const usage: Mutable<TokenUsage> = {};
    let recorded = false;
    for (const field of TOKEN_FIELDS) {
        const tokens = nonNegativeInteger(value[WIRE_NAMES[field]]);
        if (tokens === undefined) continue;
        usage[field] = tokens;
        recorded = true;
    }
    return recorded ? usage : undefined;
}

/** 두 Token Usage를 항목별로 더합니다. 양쪽 모두 기록하지 않은 항목은 비워 둡니다. */
export function addUsage(total: TokenUsage, usage: TokenUsage | undefined): TokenUsage {
    if (usage === undefined) return total;
    const sum: Mutable<TokenUsage> = { ...total };
    for (const field of TOKEN_FIELDS) {
        const tokens = usage[field];
        if (tokens !== undefined) sum[field] = (sum[field] ?? 0) + tokens;
    }
    return sum;
}

/** 여러 Token Usage를 항목별로 더합니다. */
export function sumUsage(usages: Iterable<TokenUsage | undefined>): TokenUsage {
    let total: TokenUsage = {};
    for (const usage of usages) total = addUsage(total, usage);
    return total;
}
