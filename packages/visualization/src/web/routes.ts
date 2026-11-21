import type { SessionRef } from "@agentoscope/core";

/** Session Graph를 여는 hash입니다. */
export function sessionHash(ref: SessionRef): string {
    return `#/session/${encodeURIComponent(ref.agentKind)}/${encodeURIComponent(ref.sessionId)}`;
}

export function parseSessionHash(hash: string): SessionRef | undefined {
    const match = /^#\/session\/([^/]+)\/([^/]+)$/.exec(hash);
    if (match === null) return undefined;
    try {
        return {
            agentKind: decodeURIComponent(match[1] ?? ""),
            sessionId: decodeURIComponent(match[2] ?? ""),
        };
    } catch {
        return undefined;
    }
}
