import type { TokenUsage } from "@agentoscope/core";

/** 원문의 앞부분을 보이는 길이입니다. Tooltip과 같습니다. */
export const PREVIEW_LENGTH = 200;

export function formatCount(value: number | undefined): string {
    if (value === undefined) return "–";
    if (value < 1000) return String(value);
    if (value < 1_000_000) return `${trim(value / 1000)}K`;
    return `${trim(value / 1_000_000)}M`;
}

function trim(value: number): string {
    return value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

/** 문자 수를 크기로 보입니다. */
export function formatSize(chars: number): string {
    if (chars < 1024) return `${chars} chars`;
    if (chars < 1024 * 1024) return `${trim(chars / 1024)} K chars`;
    return `${trim(chars / 1024 / 1024)} M chars`;
}

export function formatTime(us: number | undefined): string {
    if (us === undefined) return "–";
    const date = new Date(us / 1000);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
        date.getHours(),
    )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Duration입니다. 끝이 시작보다 앞이면 음수로 보이지 않고 시각이 거꾸로라고 표시합니다. */
export function formatDuration(
    startUs: number | undefined,
    endUs: number | undefined,
    estimated = false,
): string {
    if (startUs === undefined || endUs === undefined) return "";
    const us = endUs - startUs;
    if (us < 0) return "clock reversed";
    const seconds = us / 1_000_000;
    const text =
        seconds < 1
            ? `${Math.round(us / 1000)}ms`
            : seconds < 60
              ? `${seconds.toFixed(1)}s`
              : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    return estimated ? `~${text} (estimated)` : text;
}

/** Context 크기입니다. Input Token, Cache Read Token, Cache Write Token의 합이며, 하나도 없으면 비웁니다. */
export function contextSize(usage: TokenUsage | undefined): number | undefined {
    if (usage === undefined) return undefined;
    const parts = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
    if (parts.every((part) => part === undefined)) return undefined;
    return parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
}

export function formatUsage(usage: TokenUsage | undefined): string {
    if (usage === undefined) return "not recorded";
    const cache =
        usage.cacheReadTokens === undefined && usage.cacheWriteTokens === undefined
            ? undefined
            : (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    const parts = [
        `in ${formatCount(usage.inputTokens)}`,
        `cache ${formatCount(cache)}`,
        `out ${formatCount(usage.outputTokens)}`,
    ];
    if (usage.reasoningTokens !== undefined)
        parts.push(`reasoning ${formatCount(usage.reasoningTokens)}`);
    return parts.join("  ");
}

/** 앞부분 미리보기입니다. 원문이 더 길면 말줄임표와 원문 전체의 크기를 붙입니다. */
export function preview(text: string, length: number): string {
    const head = text.slice(0, PREVIEW_LENGTH);
    return length > head.length ? `${head}… (${formatSize(length)})` : head;
}

/** 에이전트 id마다 정해 둔 Lane 색입니다. */
const LANE_COLORS = ["#2a6fdb", "#d9480f", "#2b8a3e", "#ae3ec9", "#e67700", "#0c8599", "#c2255c"];

export function laneColor(agentId: string, isMain: boolean): string {
    if (isMain) return LANE_COLORS[0] as string;
    let hash = 0;
    for (const char of agentId) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
    return LANE_COLORS[1 + (hash % (LANE_COLORS.length - 1))] as string;
}
