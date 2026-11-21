/**
 * Detail Panel입니다(docs/001.model/009.VISUALIZATION.md의 Detail Panel). 고른 Node의 전체 내용을 보이며,
 * 원문은 Panel을 열 때 읽습니다. LLM Call의 input은 사용자가 펼칠 때 스트리밍으로 읽습니다.
 */

import type {
    AgentSummary,
    CompactionNode,
    GapNode,
    InterruptNode,
    LlmCallNode,
    SessionRef,
    ToolCallDetail,
    ToolCallNode,
    TurnSummary,
} from "@agentoscope/core";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { getEventBody, getToolCall, type InputItem, readLlmCallInput } from "./api";
import { ErrorMessage } from "./errors";
import { formatCount, formatDuration, formatSize, formatTime, formatUsage } from "./format";

export type Selection =
    | { readonly kind: "prompt"; readonly agentId: string; readonly turn: TurnSummary }
    | { readonly kind: "llm_call"; readonly agentId: string; readonly node: LlmCallNode }
    | { readonly kind: "tool_call"; readonly agentId: string; readonly call: ToolCallNode }
    | { readonly kind: "compaction"; readonly agentId: string; readonly node: CompactionNode }
    | { readonly kind: "interrupt"; readonly agentId: string; readonly node: InterruptNode }
    | { readonly kind: "gap"; readonly agentId: string; readonly node: GapNode };

interface PanelProps {
    readonly session: SessionRef;
    readonly selection: Selection;
    readonly agents: ReadonlyMap<string, AgentSummary>;
    readonly onSelect: (selection: Selection) => void;
    readonly onClose: () => void;
}

const TITLES: Record<Selection["kind"], string> = {
    prompt: "Prompt",
    llm_call: "LLM Call",
    tool_call: "Tool Call",
    compaction: "Compaction",
    interrupt: "Interrupt",
    gap: "Gap",
};

export function DetailPanel(props: PanelProps) {
    const { selection } = props;
    return (
        <aside class="detail-panel" aria-label="Detail Panel">
            <header>
                <h2>
                    {TITLES[selection.kind]} <span class="muted">{selection.agentId}</span>
                </h2>
                <button type="button" onClick={props.onClose} aria-label="Close">
                    ×
                </button>
            </header>
            <PanelBody {...props} />
        </aside>
    );
}

function PanelBody({ session, selection, agents, onSelect }: PanelProps): ComponentChildren {
    switch (selection.kind) {
        case "prompt":
            return <PromptDetail session={session} selection={selection} agents={agents} />;
        case "llm_call":
            return <LlmCallDetail session={session} selection={selection} onSelect={onSelect} />;
        case "tool_call":
            return <ToolCallPanel session={session} selection={selection} agents={agents} />;
        case "compaction":
            return <CompactionDetail session={session} node={selection.node} />;
        case "interrupt":
            return (
                <dl>
                    <dt>interrupted</dt>
                    <dd>{formatTime(selection.node.timestampUs)}</dd>
                    <dt>turn position</dt>
                    <dd>{selection.node.position}</dd>
                </dl>
            );
        case "gap":
            return (
                <p>
                    No record was stored at turn position {selection.node.position}
                    {selection.node.count > 1 &&
                        `..${selection.node.position + selection.node.count - 1}`}
                    . Turn positions start at 0 and increase by one, so the records in between were
                    lost or dropped before they were stored.
                </p>
            );
    }
}

/** 원문을 불러옵니다. */
function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]) {
    const [state, setState] = useState<{ value?: T; error?: unknown; loading: boolean }>({
        loading: true,
    });
    useEffect(() => {
        let cancelled = false;
        setState({ loading: true });
        load().then(
            (value) => !cancelled && setState({ value, loading: false }),
            (error: unknown) => !cancelled && setState({ error, loading: false }),
        );
        return () => {
            cancelled = true;
        };
    }, deps);
    return state;
}

function Loaded<T>({
    state,
    children,
}: {
    readonly state: { value?: T; error?: unknown; loading: boolean };
    readonly children: (value: T) => ComponentChildren;
}): ComponentChildren {
    if (state.loading) return <p class="muted">Loading…</p>;
    if (state.error !== undefined) return <ErrorMessage error={state.error} />;
    return children(state.value as T);
}

/** 큰 원문은 앞부분만 보이고, 누르면 전체를 보입니다. */
const LONG_TEXT_LIMIT = 20_000;

function LongText({ text }: { readonly text: string }) {
    const [all, setAll] = useState(false);
    const shown = all ? text : text.slice(0, LONG_TEXT_LIMIT);
    return (
        <>
            <pre class="body">{shown}</pre>
            {shown.length < text.length && (
                <button type="button" onClick={() => setAll(true)}>
                    Show all ({formatSize(text.length)})
                </button>
            )}
        </>
    );
}

function Json({ value }: { readonly value: unknown }) {
    return <LongText text={typeof value === "string" ? value : JSON.stringify(value, null, 2)} />;
}

function PromptDetail({
    session,
    selection,
    agents,
}: {
    readonly session: SessionRef;
    readonly selection: Extract<Selection, { kind: "prompt" }>;
    readonly agents: ReadonlyMap<string, AgentSummary>;
}) {
    const { turn } = selection;
    const state = useLoad(() => getEventBody(session, turn.turnId), [session, turn.turnId]);
    const parent = agents.get(selection.agentId)?.parentId;
    return (
        <>
            <dl>
                <dt>status</dt>
                <dd>{turn.status}</dd>
                <dt>time</dt>
                <dd>
                    {formatTime(turn.startedAtUs)} .. {formatTime(turn.endedAtUs)} (
                    {formatDuration(turn.startedAtUs, turn.endedAtUs)})
                </dd>
                <dt>LLM Calls</dt>
                <dd>
                    {turn.loopCount} ({turn.failedLlmCallCount} failed), Tool Calls{" "}
                    {turn.toolCallCount}
                </dd>
                <dt>tokens</dt>
                <dd>{formatUsage(turn.usage)}</dd>
                {parent !== undefined && (
                    <>
                        <dt>parent agent</dt>
                        <dd>{parent}</dd>
                    </>
                )}
            </dl>
            <h3>Prompt</h3>
            <Loaded state={state}>
                {(body) => <LongText text={typeof body.text === "string" ? body.text : ""} />}
            </Loaded>
        </>
    );
}

function LlmCallDetail({
    session,
    selection,
    onSelect,
}: {
    readonly session: SessionRef;
    readonly selection: Extract<Selection, { kind: "llm_call" }>;
    readonly onSelect: (selection: Selection) => void;
}) {
    const { node, agentId } = selection;
    const call = node.llmCall;
    const state = useLoad(() => getEventBody(session, call.id), [session, call.id]);
    const ordinals = new Map(node.toolCalls.map((tool) => [tool.toolUseId, tool]));
    return (
        <>
            <dl>
                <dt>model</dt>
                <dd>{call.model ?? "not recorded"}</dd>
                <dt>stop</dt>
                <dd>{call.stopReason ?? "not recorded"}</dd>
                {call.error !== undefined && (
                    <>
                        <dt>error</dt>
                        <dd class="status-errored">
                            {call.error.message}
                            {call.error.code !== undefined && ` (${call.error.code})`}
                            {call.error.statusCode !== undefined &&
                                ` HTTP ${call.error.statusCode}`}
                            {call.error.willRetry !== undefined &&
                                (call.error.willRetry ? ", will retry" : "")}
                        </dd>
                    </>
                )}
                {call.attempt !== undefined && (
                    <>
                        <dt>attempt</dt>
                        <dd>{call.attempt}</dd>
                    </>
                )}
                <dt>time</dt>
                <dd>
                    {formatTime(call.startedAtUs)} .. {formatTime(call.endedAtUs)} (
                    {formatDuration(call.startedAtUs, call.endedAtUs, call.startedAtEstimated)})
                </dd>
                <dt>tokens</dt>
                <dd>{formatUsage(call.usage)}</dd>
            </dl>
            <h3>Output</h3>
            <Loaded state={state}>
                {(body) => {
                    const content = Array.isArray(body.content) ? body.content : [];
                    if (content.length === 0) return <p class="muted">Empty response.</p>;
                    return content.map((block: unknown, index) => {
                        const item = (
                            typeof block === "object" && block !== null ? block : {}
                        ) as Record<string, unknown>;
                        const key = `${index}`;
                        if (item.type === "tool_use") {
                            const tool =
                                typeof item.tool_use_id === "string"
                                    ? ordinals.get(item.tool_use_id)
                                    : undefined;
                            return (
                                <div key={key} class="block">
                                    <div class="block-type">
                                        tool_use{" "}
                                        {tool === undefined ? (
                                            String(item.name)
                                        ) : (
                                            <button
                                                type="button"
                                                class="link"
                                                onClick={() =>
                                                    onSelect({
                                                        kind: "tool_call",
                                                        agentId,
                                                        call: tool,
                                                    })
                                                }
                                            >
                                                {tool.name}
                                            </button>
                                        )}
                                    </div>
                                    <Json value={item.input} />
                                </div>
                            );
                        }
                        return (
                            <div key={key} class="block">
                                <div class="block-type">{String(item.type)}</div>
                                {typeof item.text === "string" ? (
                                    <LongText text={item.text} />
                                ) : (
                                    <Json value={item} />
                                )}
                            </div>
                        );
                    });
                }}
            </Loaded>
            {state.value !== undefined &&
                Array.isArray(state.value.content) &&
                !state.value.content.some(
                    (block: unknown) =>
                        typeof block === "object" &&
                        block !== null &&
                        (block as { type?: unknown }).type === "reasoning",
                ) && (
                    <p class="muted">
                        Reasoning not recorded
                        {call.usage?.reasoningTokens !== undefined &&
                            ` (${formatCount(call.usage.reasoningTokens)} reasoning tokens)`}
                        .
                    </p>
                )}
            <h3>Input</h3>
            <InputList key={call.id} session={session} agentId={agentId} llmCallId={call.id} />
        </>
    );
}

function InputList({
    session,
    agentId,
    llmCallId,
}: {
    readonly session: SessionRef;
    readonly agentId: string;
    readonly llmCallId: string;
}) {
    const [items, setItems] = useState<InputItem[]>();
    const [error, setError] = useState<unknown>();
    const [done, setDone] = useState(false);
    const [controller, setController] = useState<AbortController>();

    useEffect(() => () => controller?.abort(), [controller]);

    const load = () => {
        const abort = new AbortController();
        setController(abort);
        setItems([]);
        setDone(false);
        const buffer: InputItem[] = [];
        let scheduled = false;
        const flush = () => {
            scheduled = false;
            setItems([...buffer]);
        };
        readLlmCallInput(
            { ...session, agentId },
            llmCallId,
            (item) => {
                buffer.push(item);
                if (!scheduled) {
                    scheduled = true;
                    requestAnimationFrame(flush);
                }
            },
            abort.signal,
        ).then(
            () => {
                flush();
                setDone(true);
            },
            (caught: unknown) => {
                if (!abort.signal.aborted) setError(caught);
            },
        );
    };

    return (
        <>
            <p class="muted">
                The input is rebuilt from the records and may differ from the request the model
                received. Input the agent does not record (system prompt, instruction files, tool
                definitions) is not shown.
            </p>
            {items === undefined ? (
                <button type="button" onClick={load}>
                    Load full input
                </button>
            ) : (
                <>
                    <ol class="input-items">
                        {items.map((item) => (
                            <InputEntry key={item.eventId} item={item} />
                        ))}
                    </ol>
                    {!done && error === undefined && <p class="muted">Loading…</p>}
                    {done && items.length === 0 && <p class="muted">No input recorded.</p>}
                </>
            )}
            {error !== undefined && <ErrorMessage error={error} />}
        </>
    );
}

function InputEntry({ item }: { readonly item: InputItem }) {
    const [open, setOpen] = useState(false);
    const text = typeof item.body.text === "string" ? item.body.text : undefined;
    const output = item.body.output;
    return (
        <li>
            <button type="button" class="link" aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? "▾" : "▸"} {item.type}
            </button>{" "}
            <span class="muted">
                {formatTime(item.timestampUs)} · {formatSize(item.size)}
            </span>
            {open &&
                (text !== undefined ? (
                    <LongText text={text} />
                ) : item.type === "tool_result" && output !== undefined ? (
                    <Json value={output} />
                ) : (
                    <Json value={item.body} />
                ))}
        </li>
    );
}

function ToolCallPanel({
    session,
    selection,
    agents,
}: {
    readonly session: SessionRef;
    readonly selection: Extract<Selection, { kind: "tool_call" }>;
    readonly agents: ReadonlyMap<string, AgentSummary>;
}) {
    const { call, agentId } = selection;
    const state = useLoad<ToolCallDetail>(
        () => getToolCall({ ...session, agentId }, call.llmCallId, call.ordinal),
        [session, agentId, call.llmCallId, call.ordinal],
    );
    const sub = call.subagentId === undefined ? undefined : agents.get(call.subagentId);
    return (
        <>
            <dl>
                <dt>tool</dt>
                <dd>{call.name}</dd>
                <dt>result</dt>
                <dd>
                    {call.isError === true
                        ? "failed"
                        : call.resultEventId === undefined
                          ? "no result"
                          : "ok"}
                </dd>
                <dt>time</dt>
                <dd>
                    {formatTime(call.startedAtUs)} .. {formatTime(call.endedAtUs)}{" "}
                    {formatDuration(call.startedAtUs, call.endedAtUs) &&
                        `(${formatDuration(call.startedAtUs, call.endedAtUs)})`}
                </dd>
                {call.subagentId !== undefined && (
                    <>
                        <dt>subagent</dt>
                        <dd>
                            {call.subagentId}
                            {sub === undefined
                                ? " (not recorded)"
                                : ` · tokens ${formatUsage(sub.usage)}`}
                        </dd>
                    </>
                )}
            </dl>
            <Loaded state={state}>
                {(detail) => (
                    <>
                        <h3>Input</h3>
                        <Json value={detail.input} />
                        <h3>Result</h3>
                        {detail.output === undefined ? (
                            <p class="muted">
                                No result recorded. The turn may have been interrupted.
                            </p>
                        ) : (
                            <Json value={detail.output} />
                        )}
                    </>
                )}
            </Loaded>
        </>
    );
}

function CompactionDetail({
    session,
    node,
}: {
    readonly session: SessionRef;
    readonly node: CompactionNode;
}) {
    const { compaction } = node;
    const summaryId = compaction.summaryEventId;
    const state = useLoad(
        () =>
            summaryId === undefined ? Promise.resolve(undefined) : getEventBody(session, summaryId),
        [session, summaryId],
    );
    return (
        <>
            <dl>
                <dt>trigger</dt>
                <dd>{compaction.trigger ?? "not recorded"}</dd>
                <dt>context before</dt>
                <dd>{formatCount(compaction.contextTokensBefore)}</dd>
                <dt>model</dt>
                <dd>{compaction.model ?? "not recorded"}</dd>
                <dt>tokens</dt>
                <dd>{formatUsage(compaction.usage)}</dd>
                <dt>time</dt>
                <dd>
                    {formatTime(compaction.startedAtUs)} .. {formatTime(compaction.endedAtUs)}
                </dd>
            </dl>
            <h3>Summary</h3>
            <Loaded state={state}>
                {(body) =>
                    body === undefined ? (
                        <p class="muted">No summary recorded.</p>
                    ) : (
                        <LongText text={typeof body.text === "string" ? body.text : ""} />
                    )
                }
            </Loaded>
        </>
    );
}
