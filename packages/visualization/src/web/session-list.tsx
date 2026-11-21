/** Session 목록입니다. 지금은 시작 시각순만 지원합니다(docs/002.implementation/011.VISUALIZATION.md의 구현 범위). */

import type { SessionSummary } from "@agentoscope/core";
import { useCallback, useEffect, useState } from "preact/hooks";
import { listSessions } from "./api";
import { ErrorMessage } from "./errors";
import { formatTime, formatUsage } from "./format";
import { sessionHash } from "./routes";

const PAGE_SIZE = 50;

interface Filter {
    readonly agent: string;
    readonly cwd: string;
    readonly host: string;
}

export function SessionList() {
    const [filter, setFilter] = useState<Filter>({ agent: "", cwd: "", host: "" });
    const [draft, setDraft] = useState<Filter>(filter);
    const [sessions, setSessions] = useState<SessionSummary[]>([]);
    const [more, setMore] = useState(true);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<unknown>();

    const load = useCallback(
        async (offset: number) => {
            setLoading(true);
            setError(undefined);
            try {
                const page = await listSessions({ ...filter, limit: PAGE_SIZE, offset });
                setSessions((current) => (offset === 0 ? page : [...current, ...page]));
                setMore(page.length === PAGE_SIZE);
            } catch (caught) {
                setError(caught);
            } finally {
                setLoading(false);
            }
        },
        [filter],
    );

    useEffect(() => {
        void load(0);
    }, [load]);

    const field = (name: keyof Filter, label: string) => (
        <label>
            {label}{" "}
            <input
                value={draft[name]}
                placeholder="all"
                onInput={(event) =>
                    setDraft({ ...draft, [name]: (event.currentTarget as HTMLInputElement).value })
                }
            />
        </label>
    );

    return (
        <main class="session-list">
            <header class="toolbar">
                <h1>Sessions</h1>
                <form
                    class="filters"
                    onSubmit={(event) => {
                        event.preventDefault();
                        setFilter(draft);
                    }}
                >
                    {field("agent", "Agent")}
                    {field("cwd", "cwd")}
                    {field("host", "Host")}
                    <button type="submit">Apply</button>
                </form>
                <span class="hint">Sorted by start time</span>
            </header>
            {error !== undefined && <ErrorMessage error={error} />}
            <ul class="sessions">
                {sessions.map((session) => (
                    <li key={`${session.agentKind}/${session.sessionId}`}>
                        <a class="session-card" href={sessionHash(session)}>
                            <div class="session-title">
                                <span class="session-id">{session.sessionId}</span>
                                <span class="agent-kind">{session.agentKind}</span>
                                {session.cwd !== undefined && (
                                    <span class="cwd">{session.cwd}</span>
                                )}
                                {session.host !== undefined && (
                                    <span class="host">{session.host}</span>
                                )}
                            </div>
                            <div class="session-meta">
                                {session.startedAtUs === undefined ? (
                                    <span>
                                        No turns recorded. First received{" "}
                                        {formatTime(session.firstReceivedAtUs)}
                                    </span>
                                ) : (
                                    <span>
                                        {formatTime(session.startedAtUs)} ..{" "}
                                        {formatTime(session.endedAtUs)}
                                    </span>
                                )}
                                <span>Turns {session.turnCount}</span>
                                <span>Subagents {Math.max(session.agentCount - 1, 0)}</span>
                                <span>Tokens {formatUsage(session.usage)}</span>
                            </div>
                        </a>
                    </li>
                ))}
            </ul>
            {!loading && sessions.length === 0 && error === undefined && (
                <p class="empty">No sessions recorded yet.</p>
            )}
            {more && sessions.length > 0 && (
                <button type="button" disabled={loading} onClick={() => void load(sessions.length)}>
                    {loading ? "Loading…" : "Load more"}
                </button>
            )}
        </main>
    );
}
