/**
 * Session Graph입니다(docs/001.model/009.VISUALIZATION.md의 Session Graph).
 * Agent마다 Lane이 하나이며, 위에서 아래로 Turn의 순서와 Turn 안 위치의 순서를 따릅니다(Grouped 보기).
 * 접힌 Turn은 Turn 목록의 요약만으로 그리고, 펼친 Turn만 Node 메타데이터를 불러옵니다
 * (docs/002.implementation/010.QUERY_API.md의 Session Graph를 불러오는 순서).
 */

import type {
    AgentSummary,
    CompactionNode,
    GapNode,
    InterruptNode,
    LlmCallNode,
    SessionDetail,
    SessionRef,
    ToolCallNode,
    TurnNodes,
    TurnSummary,
} from "@agentoscope/core";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { getSession, getTurnNodes, listTurns } from "./api";
import { DetailPanel, type Selection } from "./detail-panel";
import { ErrorMessage } from "./errors";
import {
    contextSize,
    formatCount,
    formatDuration,
    formatTime,
    formatUsage,
    laneColor,
    preview,
} from "./format";

// ── Row ───────────────────────────────────────────────────────────────

interface RowBase {
    readonly key: string;
    /** 이 행이 놓인 Lane과 그 바깥 Lane의 Agent ID입니다. 마지막이 이 행의 Agent입니다. */
    readonly lanes: readonly string[];
}

type Row = RowBase &
    (
        | { readonly kind: "turn"; readonly turn: TurnSummary; readonly expanded: boolean }
        | { readonly kind: "loading"; readonly text: string }
        | { readonly kind: "llm_call"; readonly node: LlmCallNode }
        | { readonly kind: "tool_call"; readonly call: ToolCallNode; readonly last: boolean }
        | { readonly kind: "spawn"; readonly agent: AgentSummary; readonly call: ToolCallNode }
        | { readonly kind: "return"; readonly agentId: string }
        | { readonly kind: "compaction"; readonly node: CompactionNode }
        | { readonly kind: "interrupt"; readonly node: InterruptNode }
        | { readonly kind: "gap"; readonly node: GapNode }
    );

const turnKey = (agentId: string, turnId: string) => `${agentId}\u0000${turnId}`;

/** 행이 Signal인지입니다. 오류, 실패, 결과 없음, max_tokens나 refusal, completed가 아닌 Turn입니다. */
function isSignal(row: Row): boolean {
    switch (row.kind) {
        case "turn":
            return row.turn.status !== "completed";
        case "llm_call": {
            const call = row.node.llmCall;
            return call.failed || call.stopReason === "max_tokens" || call.stopReason === "refusal";
        }
        case "tool_call":
            return row.call.isError === true || row.call.resultEventId === undefined;
        case "interrupt":
        case "gap":
            return true;
        default:
            return false;
    }
}

/** Subagent의 Turn 가운데 Tool Call이 실행 중일 때 시작한 것입니다. 하나도 없으면 모두입니다(D9: 시각으로 추정). */
function spawnedTurns(turns: readonly TurnSummary[], call: ToolCallNode): readonly TurnSummary[] {
    const within = turns.filter(
        (turn) =>
            turn.startedAtUs >= call.startedAtUs &&
            (call.endedAtUs === undefined || turn.startedAtUs <= call.endedAtUs),
    );
    return within.length > 0 ? within : turns;
}

// ── Session Graph ─────────────────────────────────────────────────────

export function SessionGraph({ session }: { readonly session: SessionRef }) {
    const [detail, setDetail] = useState<SessionDetail>();
    const [turns, setTurns] = useState<ReadonlyMap<string, readonly TurnSummary[]>>(new Map());
    const [nodes, setNodes] = useState<ReadonlyMap<string, TurnNodes>>(new Map());
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const [shownLanes, setShownLanes] = useState<ReadonlySet<string>>(new Set());
    const [selection, setSelection] = useState<Selection>();
    const [hovered, setHovered] = useState<{ row: Row; top: number; left: number }>();
    const [error, setError] = useState<unknown>();
    const requested = useRef(new Set<string>());

    // 1. Agent 트리, 2. Agent마다 Turn 목록. 처음에는 Main Agent의 마지막 Turn을 펼칩니다.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const loaded = await getSession(session);
                const lists = await Promise.all(
                    loaded.agents.map(async (agent) => {
                        const list = await listTurns({ ...session, agentId: agent.agentId });
                        return [agent.agentId, list] as const;
                    }),
                );
                if (cancelled) return;
                setDetail(loaded);
                setTurns(new Map(lists));
                const main = mainAgent(loaded);
                const last =
                    main === undefined
                        ? undefined
                        : lists.find(([id]) => id === main.agentId)?.[1].at(-1);
                if (main !== undefined && last !== undefined) {
                    setExpanded(new Set([turnKey(main.agentId, last.turnId)]));
                }
            } catch (caught) {
                if (!cancelled) setError(caught);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [session]);

    // 3. 펼친 Turn마다 Node 메타데이터를 불러옵니다.
    useEffect(() => {
        for (const key of expanded) {
            if (requested.current.has(key)) continue;
            requested.current.add(key);
            const [agentId = "", turnId = ""] = key.split("\u0000");
            getTurnNodes({ ...session, agentId }, turnId).then(
                (loaded) => setNodes((current) => new Map(current).set(key, loaded)),
                (caught: unknown) => {
                    requested.current.delete(key);
                    setError(caught);
                },
            );
        }
    }, [expanded, session]);

    const agents = useMemo(
        () => new Map((detail?.agents ?? []).map((agent) => [agent.agentId, agent])),
        [detail],
    );
    const main = detail === undefined ? undefined : mainAgent(detail);

    const rows = useMemo(() => {
        const result: Row[] = [];
        const lane = (
            agentId: string,
            outer: readonly string[],
            list: readonly TurnSummary[] | undefined,
        ) => {
            const lanes = [...outer, agentId];
            for (const turn of list ?? []) {
                const key = turnKey(agentId, turn.turnId);
                const open = expanded.has(key);
                result.push({ key, lanes, kind: "turn", turn, expanded: open });
                if (!open) continue;
                const loaded = nodes.get(key);
                if (loaded === undefined) {
                    result.push({
                        key: `${key}/loading`,
                        lanes,
                        kind: "loading",
                        text: "Loading…",
                    });
                    continue;
                }
                for (const node of loaded.nodes) {
                    const nodeKey = `${key}/${node.position}/${node.kind}`;
                    switch (node.kind) {
                        case "prompt":
                            break;
                        case "llm_call":
                            result.push({ key: nodeKey, lanes, kind: "llm_call", node });
                            node.toolCalls.forEach((call, index) => {
                                result.push({
                                    key: `${nodeKey}/${call.ordinal}`,
                                    lanes,
                                    kind: "tool_call",
                                    call,
                                    last: index === node.toolCalls.length - 1,
                                });
                                const sub =
                                    call.subagentId === undefined
                                        ? undefined
                                        : agents.get(call.subagentId);
                                // Agent 트리가 돌아 다시 같은 Agent를 만나면 그리지 않습니다.
                                if (sub === undefined || lanes.includes(sub.agentId)) return;
                                result.push({
                                    key: `${nodeKey}/${call.ordinal}/spawn`,
                                    lanes,
                                    kind: "spawn",
                                    agent: sub,
                                    call,
                                });
                                lane(
                                    sub.agentId,
                                    lanes,
                                    spawnedTurns(turns.get(sub.agentId) ?? [], call),
                                );
                                result.push({
                                    key: `${nodeKey}/${call.ordinal}/return`,
                                    lanes,
                                    kind: "return",
                                    agentId: sub.agentId,
                                });
                            });
                            break;
                        case "compaction":
                            result.push({ key: nodeKey, lanes, kind: "compaction", node });
                            break;
                        case "interrupt":
                            result.push({ key: nodeKey, lanes, kind: "interrupt", node });
                            break;
                        case "gap":
                            result.push({ key: nodeKey, lanes, kind: "gap", node });
                            break;
                    }
                }
            }
        };
        if (main !== undefined) lane(main.agentId, [], turns.get(main.agentId));
        for (const agentId of shownLanes) {
            if (agentId === main?.agentId) continue;
            result.push({
                key: `lane/${agentId}`,
                lanes: [agentId],
                kind: "loading",
                text: `Agent ${agentId}`,
            });
            lane(agentId, [], turns.get(agentId));
        }
        return result;
    }, [main, agents, turns, nodes, expanded, shownLanes]);

    // Token 막대의 길이는 불러온 LLM Call 가운데 가장 큰 Context 크기를 기준으로 합니다.
    const maxContext = useMemo(() => {
        let max = 1;
        for (const loaded of nodes.values()) {
            for (const node of loaded.nodes) {
                if (node.kind !== "llm_call") continue;
                max = Math.max(max, contextSize(node.llmCall.usage) ?? 0);
            }
        }
        return max;
    }, [nodes]);

    if (error !== undefined && detail === undefined) {
        return (
            <main class="graph-page">
                <a href="#/">&lt; Sessions</a>
                <ErrorMessage error={error} />
            </main>
        );
    }
    if (detail === undefined) return <main class="graph-page">Loading…</main>;

    const toggle = (key: string) =>
        setExpanded((current) => {
            const next = new Set(current);
            if (!next.delete(key)) next.add(key);
            return next;
        });
    const isMain = (agentId: string) => agentId === main?.agentId;
    const select = (row: Row): Selection | undefined => {
        const agentId = row.lanes.at(-1) ?? "";
        switch (row.kind) {
            case "turn":
                return { kind: "prompt", agentId, turn: row.turn };
            case "llm_call":
                return { kind: "llm_call", agentId, node: row.node };
            case "tool_call":
                return { kind: "tool_call", agentId, call: row.call };
            case "compaction":
                return { kind: "compaction", agentId, node: row.node };
            case "interrupt":
                return { kind: "interrupt", agentId, node: row.node };
            case "gap":
                return { kind: "gap", agentId, node: row.node };
            default:
                return undefined;
        }
    };
    const firstPrompt = main === undefined ? undefined : turns.get(main.agentId)?.[0];
    const others = detail.agents.filter((agent) => agent.agentId !== main?.agentId);

    return (
        <main class={`graph-page ${selection === undefined ? "" : "with-detail"}`}>
            <header class="graph-header">
                <a href="#/">&lt; Sessions</a>
                <h1>
                    {firstPrompt === undefined
                        ? main === undefined
                            ? "Main Agent not recorded"
                            : detail.sessionId
                        : preview(firstPrompt.promptPreview, firstPrompt.promptLength)}
                </h1>
                <div class="session-meta">
                    <span class="agent-kind">{detail.agentKind}</span>
                    {detail.cwd !== undefined && <span class="cwd">{detail.cwd}</span>}
                    {detail.host !== undefined && <span class="host">{detail.host}</span>}
                    <span>
                        {formatTime(detail.startedAtUs)} .. {formatTime(detail.endedAtUs)}
                    </span>
                </div>
                <div class="session-meta">
                    <span>Turns {detail.turnCount}</span>
                    <span>Subagents {others.length}</span>
                    <span>Tokens {formatUsage(detail.usage)}</span>
                </div>
                {error !== undefined && <ErrorMessage error={error} />}
            </header>
            <section class="graph" aria-label="Session Graph">
                {main === undefined && <p class="empty">The Main Agent has not been recorded.</p>}
                {rows.map((row) => {
                    const target = select(row);
                    const selected = target !== undefined && sameSelection(target, selection);
                    return (
                        // biome-ignore lint/a11y/useSemanticElements: 행 안에 Turn을 접는 버튼이 있어 button으로 둘 수 없습니다.
                        <div
                            key={row.key}
                            class={`row row-${row.kind}${isSignal(row) ? " signal" : ""}${
                                selected ? " selected" : ""
                            }`}
                            role="button"
                            aria-pressed={selected}
                            tabIndex={target === undefined ? -1 : 0}
                            onClick={() => target !== undefined && setSelection(target)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && target !== undefined)
                                    setSelection(target);
                                if (event.key === " " && row.kind === "turn") {
                                    event.preventDefault();
                                    toggle(row.key);
                                }
                            }}
                            onMouseEnter={(event) =>
                                showTooltip(event.currentTarget, row, setHovered)
                            }
                            onFocus={(event) => showTooltip(event.currentTarget, row, setHovered)}
                            onMouseLeave={() => setHovered(undefined)}
                            onBlur={() => setHovered(undefined)}
                        >
                            <Gutter lanes={row.lanes} isMain={isMain} kind={row.kind} />
                            <RowLabel row={row} toggle={toggle} agents={agents} turns={turns} />
                            <span class="tokens">
                                <TokenCell row={row} maxContext={maxContext} agents={agents} />
                            </span>
                        </div>
                    );
                })}
            </section>
            {others.length > 0 && (
                <section class="agents">
                    <h2>Agents</h2>
                    <ul>
                        {detail.agents.map((agent) => {
                            const parentMissing =
                                agent.parentId !== undefined && !agents.has(agent.parentId);
                            return (
                                <li key={agent.agentId}>
                                    <span
                                        class="lane-swatch"
                                        style={{
                                            background: laneColor(
                                                agent.agentId,
                                                isMain(agent.agentId),
                                            ),
                                        }}
                                    />
                                    <span class="agent-id">{agent.agentId}</span>
                                    {agent.parentId === undefined ? (
                                        <span class="badge">main</span>
                                    ) : (
                                        <span>
                                            parent {agent.parentId}
                                            {parentMissing && " (parent agent not recorded)"}
                                        </span>
                                    )}
                                    <span>Turns {agent.turnCount}</span>
                                    <span>Tokens {formatUsage(agent.usage)}</span>
                                    {!isMain(agent.agentId) && (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setShownLanes((current) => {
                                                    const next = new Set(current);
                                                    if (!next.delete(agent.agentId))
                                                        next.add(agent.agentId);
                                                    return next;
                                                })
                                            }
                                        >
                                            {shownLanes.has(agent.agentId)
                                                ? "Hide lane"
                                                : "Show lane"}
                                        </button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </section>
            )}
            {hovered !== undefined && <Tooltip {...hovered} agents={agents} />}
            {selection !== undefined && (
                <DetailPanel
                    session={session}
                    selection={selection}
                    agents={agents}
                    onSelect={setSelection}
                    onClose={() => setSelection(undefined)}
                />
            )}
        </main>
    );
}

function mainAgent(detail: SessionDetail): AgentSummary | undefined {
    return detail.agents.find((agent) => agent.parentId === undefined);
}

function sameSelection(a: Selection, b: Selection | undefined): boolean {
    if (b === undefined || a.kind !== b.kind || a.agentId !== b.agentId) return false;
    switch (a.kind) {
        case "prompt":
            return b.kind === "prompt" && a.turn.turnId === b.turn.turnId;
        case "llm_call":
            return b.kind === "llm_call" && a.node.llmCall.id === b.node.llmCall.id;
        case "tool_call":
            return (
                b.kind === "tool_call" &&
                a.call.llmCallId === b.call.llmCallId &&
                a.call.ordinal === b.call.ordinal
            );
        case "compaction":
            return b.kind === "compaction" && a.node.compaction.id === b.node.compaction.id;
        case "interrupt":
            return b.kind === "interrupt" && a.node.eventId === b.node.eventId;
        case "gap":
            return b.kind === "gap" && a.node.position === b.node.position;
    }
}

// ── 행의 부분 ─────────────────────────────────────────────────────────

const GLYPHS: Record<Row["kind"], string> = {
    turn: "@",
    loading: "·",
    llm_call: "*",
    tool_call: "o",
    spawn: "\\",
    return: "/",
    compaction: "=",
    interrupt: "x",
    gap: "⋮",
};

function Gutter({
    lanes,
    isMain,
    kind,
}: {
    readonly lanes: readonly string[];
    readonly isMain: (agentId: string) => boolean;
    readonly kind: Row["kind"];
}) {
    return (
        <span class="gutter" aria-hidden="true">
            {lanes.map((agentId, index) => {
                const color = laneColor(agentId, isMain(agentId));
                const own = index === lanes.length - 1;
                return (
                    <span key={agentId} class="lane" style={{ borderColor: color }}>
                        {own && (
                            <span class={`glyph glyph-${kind}`} style={{ color }}>
                                {kind === "tool_call" ? `├${GLYPHS[kind]}` : GLYPHS[kind]}
                            </span>
                        )}
                    </span>
                );
            })}
        </span>
    );
}

function RowLabel({
    row,
    toggle,
    agents,
    turns,
}: {
    readonly row: Row;
    readonly toggle: (key: string) => void;
    readonly agents: ReadonlyMap<string, AgentSummary>;
    readonly turns: ReadonlyMap<string, readonly TurnSummary[]>;
}): ComponentChildren {
    switch (row.kind) {
        case "turn": {
            const { turn } = row;
            return (
                <span class="label">
                    <button
                        type="button"
                        class="toggle"
                        aria-label={row.expanded ? "Collapse turn" : "Expand turn"}
                        aria-expanded={row.expanded}
                        onClick={(event) => {
                            event.stopPropagation();
                            toggle(row.key);
                        }}
                    >
                        {row.expanded ? "▾" : "▸"}
                    </button>
                    <span class={`status status-${turn.status}`}>{turn.status}</span>
                    <span class="text">"{turn.promptPreview.slice(0, 80)}"</span>
                    <span class="muted">
                        {turn.loopCount} LLM
                        {turn.failedLlmCallCount > 0 && ` (${turn.failedLlmCallCount} failed)`}
                        {turn.compactionCount > 0 && `, ${turn.compactionCount} compaction`}
                    </span>
                    <span class="duration">{formatDuration(turn.startedAtUs, turn.endedAtUs)}</span>
                </span>
            );
        }
        case "loading":
            return <span class="label muted">{row.text}</span>;
        case "llm_call": {
            const call = row.node.llmCall;
            return (
                <span class="label">
                    <span class="name">LLM Call</span>
                    {call.failed ? (
                        <span class="status status-errored">
                            FAILED{call.error ? `: ${call.error.message}` : ""}
                        </span>
                    ) : (
                        <span class="muted">{call.stopReason ?? "no stop reason"}</span>
                    )}
                    {call.attempt !== undefined && (
                        <span class="muted">attempt {call.attempt}</span>
                    )}
                    {call.model !== undefined && <span class="muted">{call.model}</span>}
                    <span class="duration">
                        {formatDuration(call.startedAtUs, call.endedAtUs, call.startedAtEstimated)}
                    </span>
                </span>
            );
        }
        case "tool_call": {
            const { call } = row;
            return (
                <span class="label">
                    <span class="name">{call.name}</span>
                    <span class="text">{call.inputPreview.slice(0, 80)}</span>
                    {call.isError === true && <span class="status status-errored">FAILED</span>}
                    {call.resultEventId === undefined && (
                        <span class="status status-in_progress">(no result)</span>
                    )}
                    {call.subagentId !== undefined && !call.subagentRecorded && (
                        <span class="muted">Subagent {call.subagentId} not recorded</span>
                    )}
                    <span class="duration">{formatDuration(call.startedAtUs, call.endedAtUs)}</span>
                </span>
            );
        }
        case "spawn": {
            const count = spawnedTurns(turns.get(row.agent.agentId) ?? [], row.call).length;
            return (
                <span class="label muted">
                    Spawned {row.agent.agentId} from {row.call.name} ({count} turn
                    {count === 1 ? "" : "s"})
                </span>
            );
        }
        case "return":
            return (
                <span class="label muted">
                    {agents.get(row.agentId)?.agentId ?? row.agentId} returned
                </span>
            );
        case "compaction": {
            const { compaction } = row.node;
            return (
                <span class="label">
                    <span class="name">Compaction</span>
                    {compaction.trigger !== undefined && (
                        <span class="muted">({compaction.trigger})</span>
                    )}
                    {compaction.contextTokensBefore !== undefined && (
                        <span class="muted">
                            {formatCount(compaction.contextTokensBefore)} before
                        </span>
                    )}
                    {compaction.summaryEventId === undefined && (
                        <span class="muted">(no summary)</span>
                    )}
                </span>
            );
        }
        case "interrupt":
            return (
                <span class="label">
                    <span class="name">Interrupted</span>
                    <span class="muted">{formatTime(row.node.timestampUs)}</span>
                </span>
            );
        case "gap":
            return (
                <span class="label muted">
                    {row.node.count} record{row.node.count === 1 ? "" : "s"} missing at position{" "}
                    {row.node.position}
                    {row.node.count > 1 && `..${row.node.position + row.node.count - 1}`}
                </span>
            );
    }
}

function TokenCell({
    row,
    maxContext,
    agents,
}: {
    readonly row: Row;
    readonly maxContext: number;
    readonly agents: ReadonlyMap<string, AgentSummary>;
}): ComponentChildren {
    switch (row.kind) {
        case "turn":
            return <span class="total">{formatCount(totalTokens(row.turn.usage))}</span>;
        case "llm_call": {
            const usage = row.node.llmCall.usage;
            const context = contextSize(usage);
            if (usage === undefined || context === undefined) return <span class="muted">–</span>;
            const width = 120;
            const scale = (value: number | undefined) => ((value ?? 0) / maxContext) * width;
            const parts = [
                { value: usage.inputTokens, class: "bar-input" },
                { value: usage.cacheReadTokens, class: "bar-cache-read" },
                { value: usage.cacheWriteTokens, class: "bar-cache-write" },
            ];
            let x = 0;
            return (
                <>
                    <svg
                        class="bar"
                        width={width}
                        height="10"
                        role="img"
                        aria-label={`context ${context}`}
                    >
                        <rect class="bar-track" x="0" y="0" width={width} height="10" />
                        {parts.map((part) => {
                            const w = scale(part.value);
                            const rect = (
                                <rect
                                    key={part.class}
                                    class={part.class}
                                    x={x}
                                    y="0"
                                    width={w}
                                    height="10"
                                />
                            );
                            x += w;
                            return rect;
                        })}
                    </svg>
                    <span class="total">
                        {formatCount(context)}
                        {usage.outputTokens !== undefined && ` +${formatCount(usage.outputTokens)}`}
                    </span>
                </>
            );
        }
        case "compaction": {
            const { compaction } = row.node;
            return (
                <span class="total">
                    {formatCount(compaction.contextTokensBefore)}
                    {compaction.usage !== undefined &&
                        ` / ${formatCount(totalTokens(compaction.usage))}`}
                </span>
            );
        }
        case "spawn":
            return (
                <span class="total">
                    {formatCount(totalTokens(agents.get(row.agent.agentId)?.usage ?? {}))}
                </span>
            );
        default:
            return null;
    }
}

function totalTokens(usage: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
}): number | undefined {
    const parts = [
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
    ];
    if (parts.every((part) => part === undefined)) return undefined;
    return parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
}

// ── Tooltip ───────────────────────────────────────────────────────────

function showTooltip(
    element: EventTarget | null,
    row: Row,
    set: (value: { row: Row; top: number; left: number }) => void,
) {
    if (!(element instanceof HTMLElement)) return;
    const rect = element.getBoundingClientRect();
    set({ row, top: rect.bottom + 4, left: rect.left + 40 });
}

function Tooltip({
    row,
    top,
    left,
    agents,
}: {
    readonly row: Row;
    readonly top: number;
    readonly left: number;
    readonly agents: ReadonlyMap<string, AgentSummary>;
}) {
    const lines = tooltipLines(row, agents);
    if (lines.length === 0) return null;
    return (
        <div class="tooltip" role="tooltip" style={{ top, left }}>
            {lines.map((line) => (
                <div key={line}>{line}</div>
            ))}
        </div>
    );
}

function tooltipLines(row: Row, agents: ReadonlyMap<string, AgentSummary>): string[] {
    switch (row.kind) {
        case "turn": {
            const { turn } = row;
            const agent = agents.get(row.lanes.at(-1) ?? "");
            return [
                preview(turn.promptPreview, turn.promptLength),
                `${formatTime(turn.startedAtUs)} · ${turn.promptLength} chars`,
                ...(agent?.parentId === undefined ? [] : [`Subagent ${agent.agentId}`]),
                `Tokens ${formatUsage(turn.usage)}`,
            ];
        }
        case "llm_call": {
            const call = row.node.llmCall;
            return [
                `model ${call.model ?? "not recorded"}`,
                call.failed
                    ? `error ${call.error?.message ?? "unknown"}`
                    : `stop ${call.stopReason ?? "not recorded"}`,
                ...(call.attempt === undefined ? [] : [`attempt ${call.attempt}`]),
                `duration ${formatDuration(call.startedAtUs, call.endedAtUs, call.startedAtEstimated)}`,
                `tokens ${formatUsage(call.usage)}`,
                ...(row.node.toolCalls.length === 0
                    ? []
                    : [`tools ${row.node.toolCalls.map((tool) => tool.name).join(", ")}`]),
            ];
        }
        case "tool_call": {
            const { call } = row;
            const sub = call.subagentId === undefined ? undefined : agents.get(call.subagentId);
            return [
                call.name,
                preview(call.inputPreview, call.inputLength),
                call.isError === true
                    ? "failed"
                    : call.resultEventId === undefined
                      ? "no result"
                      : "succeeded",
                `duration ${formatDuration(call.startedAtUs, call.endedAtUs) || "unknown"}`,
                ...(call.resultLength === undefined ? [] : [`result ${call.resultLength} chars`]),
                ...(call.subagentId === undefined
                    ? []
                    : [
                          `Subagent ${call.subagentId}${
                              sub === undefined
                                  ? " (not recorded)"
                                  : ` · tokens ${formatUsage(sub.usage)}`
                          }`,
                      ]),
            ];
        }
        case "compaction": {
            const { compaction } = row.node;
            return [
                `trigger ${compaction.trigger ?? "not recorded"}`,
                `context before ${formatCount(compaction.contextTokensBefore)}`,
                `summary tokens ${formatUsage(compaction.usage)}`,
            ];
        }
        case "interrupt":
            return [`Interrupted at ${formatTime(row.node.timestampUs)}`];
        case "gap":
            return [
                `Turn positions ${row.node.position}..${row.node.position + row.node.count - 1} were not stored.`,
            ];
        default:
            return [];
    }
}
