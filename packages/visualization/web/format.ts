import type { TokenUsage } from "./api";

export const TOKEN_SERIES = [
  { key: "input_tokens", label: "Input", color: "var(--series-1)" },
  { key: "cache_read_tokens", label: "Cache Read", color: "var(--series-2)" },
  { key: "cache_write_tokens", label: "Cache Write", color: "var(--series-3)" },
  { key: "output_tokens", label: "Output", color: "var(--series-4)" },
  { key: "reasoning_tokens", label: "Reasoning", color: "var(--series-5)" },
] as const;

export function totalTokens(usage: TokenUsage): number {
  return TOKEN_SERIES.reduce((sum, series) => sum + (usage[series.key] ?? 0), 0);
}

const NUMBER = new Intl.NumberFormat("en-US");

export function formatCount(value: number | undefined): string {
  return value === undefined ? "–" : NUMBER.format(value);
}

export function formatTime(us: number | undefined): string {
  if (us === undefined) return "–";
  return new Date(us / 1000).toLocaleString("ko-KR", { hour12: false });
}

export function formatDuration(startUs: number | undefined, endUs: number | undefined): string {
  if (startUs === undefined || endUs === undefined) return "–";
  const seconds = (endUs - startUs) / 1_000_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

export function shortId(id: string): string {
  return id.length > 14 ? `…${id.slice(-10)}` : id;
}

export function prettyJson(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
