import type { ComponentChildren } from "preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  type AgentSummary,
  api,
  type CompactionView,
  type LoopView,
  type RawBlock,
  type RawEvent,
  type SessionDetail,
  type SessionSummary,
  type TokenUsage,
  type ToolCallBody,
  type ToolCallView,
  type TurnDetail,
  type TurnStatus,
  type TurnSummary,
} from "./api";
import { TokenChart } from "./chart";
import {
  formatCount,
  formatDuration,
  formatTime,
  prettyJson,
  shortId,
  TOKEN_SERIES,
  totalTokens,
} from "./format";

const PAGE_SIZE = 50;

type Route =
  | { readonly page: "sessions" }
  | {
      readonly page: "session";
      readonly agent: string;
      readonly id: string;
      readonly agentPk?: number;
      readonly turnId?: string;
    };

function parseRoute(hash: string): Route {
  const [, kind, ...rest] = hash.replace(/^#/, "").split("/").map(decodeURIComponent);
  if (kind === "s" && rest[0] && rest[1]) {
    const [agent, id, pk, turnId] = rest;
    return {
      page: "session",
      agent,
      id,
      ...(pk ? { agentPk: Number(pk) } : {}),
      ...(turnId ? { turnId } : {}),
    };
  }
  return { page: "sessions" };
}

function hrefOf(agent: string, id: string, agentPk?: number, turnId?: string): string {
  const parts = ["#", "s", agent, id];
  if (agentPk !== undefined) parts.push(String(agentPk));
  if (turnId !== undefined) parts.push(turnId);
  return parts.map(encodeURIComponent).join("/").replace("%23", "#");
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const listener = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", listener);
    return () => removeEventListener("hashchange", listener);
  }, []);
  return route;
}

interface Loaded<T> {
  readonly data?: T;
  readonly error?: string;
}

function useLoad<T>(load: () => Promise<T>, keys: readonly unknown[]): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({});
  useEffect(() => {
    let current = true;
    setState({});
    load().then(
      (data) => current && setState({ data }),
      (error: Error) => current && setState({ error: error.message }),
    );
    return () => {
      current = false;
    };
  }, keys);
  return state;
}

function Status({ loaded }: { readonly loaded: Loaded<unknown> }) {
  if (loaded.error) return <p class="error">불러오지 못했습니다: {loaded.error}</p>;
  return loaded.data === undefined ? <p class="muted">불러오는 중…</p> : null;
}

const STATUS_LABELS: Readonly<Record<TurnStatus, { icon: string; label: string }>> = {
  completed: { icon: "✓", label: "completed" },
  interrupted: { icon: "■", label: "interrupted" },
  errored: { icon: "!", label: "errored" },
  in_progress: { icon: "…", label: "in progress" },
};

function StatusBadge({ status }: { readonly status: TurnStatus }) {
  const { icon, label } = STATUS_LABELS[status];
  return (
    <span class={`badge ${status}`}>
      <span aria-hidden="true">{icon}</span> {label}
    </span>
  );
}

function UsageCells({ usage }: { readonly usage: TokenUsage }) {
  return (
    <>
      {TOKEN_SERIES.map((series) => (
        <td key={series.key} class="num">
          {formatCount(usage[series.key])}
        </td>
      ))}
    </>
  );
}

function UsageHeaders() {
  return (
    <>
      {TOKEN_SERIES.map((series) => (
        <th key={series.key} class="num">
          {series.label}
        </th>
      ))}
    </>
  );
}

function SessionsPage() {
  const [agent, setAgent] = useState("");
  const [cwd, setCwd] = useState("");
  const [offset, setOffset] = useState(0);
  const sessions = useLoad(
    () => api.sessions({ agent, cwd, offset, limit: PAGE_SIZE }),
    [agent, cwd, offset],
  );
  const rows = sessions.data ?? [];

  return (
    <main>
      <h1>Sessions</h1>
      <div class="filters">
        <label>
          에이전트{" "}
          <input
            value={agent}
            placeholder="opencode"
            onChange={(event) => {
              setOffset(0);
              setAgent(event.currentTarget.value);
            }}
          />
        </label>
        <label>
          cwd{" "}
          <input
            value={cwd}
            placeholder="/path/to/project"
            onChange={(event) => {
              setOffset(0);
              setCwd(event.currentTarget.value);
            }}
          />
        </label>
      </div>
      <Status loaded={sessions} />
      {sessions.data && rows.length === 0 && <p class="muted">수집한 Session이 없습니다.</p>}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>시작</th>
              <th>첫 프롬프트</th>
              <th>cwd</th>
              <th class="num">Agent</th>
              <th class="num">Turn</th>
              <th class="num">미완료</th>
              <th class="num">Token</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((session) => (
              <SessionRow key={`${session.agent}/${session.id}`} session={session} />
            ))}
          </tbody>
        </table>
      )}
      <div class="pager">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
        >
          이전
        </button>
        <button
          type="button"
          disabled={rows.length < PAGE_SIZE}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          다음
        </button>
      </div>
    </main>
  );
}

function SessionRow({ session }: { readonly session: SessionSummary }) {
  return (
    <tr>
      <td class="nowrap">{formatTime(session.startedAtUs)}</td>
      <td class="prompt">
        <a href={hrefOf(session.agent, session.id)}>{session.firstPrompt || shortId(session.id)}</a>
      </td>
      <td class="mono">{session.cwd ?? "–"}</td>
      <td class="num">{session.agentCount}</td>
      <td class="num">{session.turnCount}</td>
      <td class="num">{session.unfinishedTurnCount}</td>
      <td class="num">{formatCount(totalTokens(session.usage))}</td>
    </tr>
  );
}

function AgentTree({
  session,
  selected,
}: {
  readonly session: SessionDetail;
  readonly selected: number;
}) {
  const known = new Set(session.agents.map((agent) => agent.id));
  const roots = session.agents.filter(
    (agent) => agent.parentId === undefined || !known.has(agent.parentId),
  );

  function renderAgent(agent: AgentSummary): ComponentChildren {
    const children = session.agents.filter((child) => child.parentId === agent.id);
    return (
      <li key={agent.pk}>
        <a
          class={agent.pk === selected ? "selected" : ""}
          href={hrefOf(session.agent, session.id, agent.pk)}
        >
          {agent.parentId === undefined ? "Main Agent" : "Subagent"}{" "}
          <span class="mono muted">{shortId(agent.id)}</span>
        </a>
        <div class="muted small">
          Turn {agent.turnCount} · Token {formatCount(totalTokens(agent.usage))}
        </div>
        {children.length > 0 && <ul>{children.map(renderAgent)}</ul>}
      </li>
    );
  }

  return <ul class="tree">{roots.map(renderAgent)}</ul>;
}

function SessionPage({ route }: { readonly route: Extract<Route, { page: "session" }> }) {
  const session = useLoad(() => api.session(route.agent, route.id), [route.agent, route.id]);
  if (!session.data)
    return (
      <main>
        <Status loaded={session} />
      </main>
    );
  const detail = session.data;
  const main = detail.agents.find((agent) => agent.parentId === undefined) ?? detail.agents[0];
  const agentPk = route.agentPk ?? main?.pk;

  return (
    <main>
      <p>
        <a href="#/">← Sessions</a>
      </p>
      <h1>
        Session <span class="mono muted">{shortId(detail.id)}</span>
      </h1>
      <p class="muted">
        {detail.agent} · {detail.cwd ?? "cwd 없음"} · {detail.host ?? "host 없음"} ·{" "}
        {formatTime(detail.startedAtUs)} · {formatDuration(detail.startedAtUs, detail.endedAtUs)}
      </p>
      <div class="columns">
        <aside>
          <h2>Agent</h2>
          {agentPk !== undefined && <AgentTree session={detail} selected={agentPk} />}
          <button
            type="button"
            class="danger"
            onClick={async () => {
              if (!confirm("이 Session의 데이터를 모두 지웁니다. 되돌릴 수 없습니다.")) return;
              await api.deleteSession(detail.agent, detail.id);
              location.hash = "#/";
            }}
          >
            Session 삭제
          </button>
        </aside>
        <section>
          {agentPk !== undefined && (
            <TurnList session={detail} agentPk={agentPk} turnId={route.turnId} />
          )}
        </section>
      </div>
    </main>
  );
}

function TurnList({
  session,
  agentPk,
  turnId,
}: {
  readonly session: SessionDetail;
  readonly agentPk: number;
  readonly turnId: string | undefined;
}) {
  const turns = useLoad(() => api.turns(agentPk), [agentPk]);
  return (
    <>
      <h2>Turn</h2>
      <Status loaded={turns} />
      <table>
        <thead>
          <tr>
            <th>시작</th>
            <th>상태</th>
            <th>프롬프트</th>
            <th class="num">Loop</th>
            <th class="num">Tool Call</th>
            <th class="num">오류</th>
            <th class="num">Duration</th>
            <th class="num">Token</th>
          </tr>
        </thead>
        <tbody>
          {(turns.data ?? []).map((turn) => (
            <TurnRow
              key={turn.id}
              turn={turn}
              href={hrefOf(session.agent, session.id, agentPk, turn.id)}
              selected={turn.id === turnId}
            />
          ))}
        </tbody>
      </table>
      {turnId !== undefined && <TurnPanel session={session} agentPk={agentPk} turnId={turnId} />}
    </>
  );
}

function TurnRow({
  turn,
  href,
  selected,
}: {
  readonly turn: TurnSummary;
  readonly href: string;
  readonly selected: boolean;
}) {
  return (
    <tr class={selected ? "selected" : ""}>
      <td class="nowrap">{formatTime(turn.startedAtUs)}</td>
      <td class="nowrap">
        <StatusBadge status={turn.status} />
      </td>
      <td class="prompt">
        <a href={href}>
          {turn.prompt || "(프롬프트 없음)"}
          {turn.promptTruncated ? "…" : ""}
        </a>
      </td>
      <td class="num">{turn.loopCount}</td>
      <td class="num">{turn.toolCallCount}</td>
      <td class="num">{turn.failedLlmCallCount}</td>
      <td class="num">{formatDuration(turn.startedAtUs, turn.endedAtUs)}</td>
      <td class="num">{formatCount(totalTokens(turn.usage))}</td>
    </tr>
  );
}

type TimelineItem =
  | {
      readonly kind: "loop";
      readonly position: number;
      readonly loop: LoopView;
      readonly index: number;
    }
  | { readonly kind: "compaction"; readonly position: number; readonly compaction: CompactionView };

function TurnPanel({
  session,
  agentPk,
  turnId,
}: {
  readonly session: SessionDetail;
  readonly agentPk: number;
  readonly turnId: string;
}) {
  const turn = useLoad(() => api.turn(agentPk, turnId), [agentPk, turnId]);
  if (!turn.data) return <Status loaded={turn} />;
  const detail: TurnDetail = turn.data;
  const items: TimelineItem[] = [
    ...detail.loops.map((loop, index) => ({
      kind: "loop" as const,
      position: loop.llmCall.position,
      loop,
      index,
    })),
    ...detail.compactions.map((compaction) => ({
      kind: "compaction" as const,
      position: compaction.position,
      compaction,
    })),
  ].sort((a, b) => a.position - b.position);

  return (
    <div class="panel">
      <h2>Turn 상세</h2>
      <p>
        <StatusBadge status={detail.status} />{" "}
        <span class="muted">{formatDuration(detail.startedAtUs, detail.endedAtUs)}</span>
      </p>
      <EventText agentPk={agentPk} eventId={detail.id} field="text" />
      {items.length > 0 && (
        <TokenChart
          bars={items.map((item) =>
            item.kind === "loop"
              ? {
                  key: item.loop.id,
                  label: `Loop ${item.index + 1}`,
                  usage: item.loop.llmCall.usage,
                }
              : { key: item.compaction.id, label: "Compaction", usage: item.compaction.usage },
          )}
        />
      )}
      <div class="timeline">
        {items.map((item) =>
          item.kind === "loop" ? (
            <LoopCard
              key={item.loop.id}
              session={session}
              agentPk={agentPk}
              loop={item.loop}
              index={item.index}
            />
          ) : (
            <CompactionCard
              key={item.compaction.id}
              agentPk={agentPk}
              compaction={item.compaction}
            />
          ),
        )}
      </div>
    </div>
  );
}

function EventText({
  agentPk,
  eventId,
  field,
}: {
  readonly agentPk: number;
  readonly eventId: string;
  readonly field: "text";
}) {
  const event = useLoad(() => api.event(agentPk, eventId), [agentPk, eventId]);
  if (!event.data) return <Status loaded={event} />;
  return <pre>{event.data[field] || "(비어 있음)"}</pre>;
}

function LoopCard({
  session,
  agentPk,
  loop,
  index,
}: {
  readonly session: SessionDetail;
  readonly agentPk: number;
  readonly loop: LoopView;
  readonly index: number;
}) {
  const { llmCall } = loop;
  const [tab, setTab] = useState<"output" | "input" | undefined>();
  return (
    <article class="card">
      <header>
        <strong>Loop {index + 1}</strong>
        <span>{llmCall.model ?? "모델 없음"}</span>
        <span class="muted">
          {llmCall.stopReason ?? (llmCall.failed ? "error" : "stop reason 없음")}
        </span>
        <span class="muted">
          {formatDuration(llmCall.startedAtUs, llmCall.endedAtUs)}
          {llmCall.startedAtEstimated ? " (추정)" : ""}
        </span>
        <span class="spacer" />
        <button type="button" onClick={() => setTab(tab === "output" ? undefined : "output")}>
          output
        </button>
        <button type="button" onClick={() => setTab(tab === "input" ? undefined : "input")}>
          input
        </button>
      </header>
      {llmCall.failed && <p class="error">LLM 호출 오류: {llmCall.errorMessage}</p>}
      <table class="compact">
        <thead>
          <tr>
            <UsageHeaders />
          </tr>
        </thead>
        <tbody>
          <tr>
            <UsageCells usage={llmCall.usage} />
          </tr>
        </tbody>
      </table>
      {tab === "output" && <OutputView agentPk={agentPk} llmCallId={llmCall.id} />}
      {tab === "input" && <InputView agentPk={agentPk} llmCallId={llmCall.id} />}
      {loop.toolCalls.map((call) => (
        <ToolCallRow key={call.ordinal} session={session} agentPk={agentPk} call={call} />
      ))}
    </article>
  );
}

function BlockView({ block }: { readonly block: RawBlock }) {
  return (
    <div class="block">
      <div class="block-title">
        {block.type === "tool_use" ? `tool_use: ${block.name}` : block.type}
      </div>
      <pre>
        {block.type === "tool_use" ? prettyJson(block.input) : (block.text ?? prettyJson(block))}
      </pre>
    </div>
  );
}

function OutputView({
  agentPk,
  llmCallId,
}: {
  readonly agentPk: number;
  readonly llmCallId: string;
}) {
  const event = useLoad(() => api.event(agentPk, llmCallId), [agentPk, llmCallId]);
  if (!event.data) return <Status loaded={event} />;
  const content = event.data.content ?? [];
  if (content.length === 0) return <p class="muted">응답 내용이 없습니다.</p>;
  return (
    <>
      {content.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </>
  );
}

function InputView({
  agentPk,
  llmCallId,
}: {
  readonly agentPk: number;
  readonly llmCallId: string;
}) {
  const [events, setEvents] = useState<RawEvent[]>([]);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  useEffect(() => {
    let current = true;
    setEvents([]);
    setDone(false);
    const received: RawEvent[] = [];
    api
      .streamInput(agentPk, llmCallId, (event) => {
        received.push(event);
        if (current) setEvents([...received]);
      })
      .then(
        () => current && setDone(true),
        (error: Error) => current && setFailure(error.message),
      );
    return () => {
      current = false;
    };
  }, [agentPk, llmCallId]);

  return (
    <div class="input-list">
      <p class="muted small">
        Session Log에 기록된 input만 보입니다. 시스템 프롬프트와 도구 정의는 OpenCode가 기록하지
        않습니다.
      </p>
      {events.map((event) => (
        <InputEvent key={event.event_id} event={event} />
      ))}
      {failure && <p class="error">{failure}</p>}
      {!done && !failure && <p class="muted">불러오는 중…</p>}
    </div>
  );
}

function InputEvent({ event }: { readonly event: RawEvent }) {
  const summary = eventSummary(event);
  return (
    <details>
      <summary>
        <span class="event-type">{event.type}</span> <span class="muted">{summary}</span>
      </summary>
      {event.content ? (
        event.content.map((block, index) => <BlockView key={index} block={block} />)
      ) : (
        <pre>{event.text ?? prettyJson(event.output ?? event)}</pre>
      )}
    </details>
  );
}

function eventSummary(event: RawEvent): string {
  const text = event.text ?? (typeof event.output === "string" ? event.output : undefined);
  if (text !== undefined) return text.slice(0, 120);
  if (event.content) {
    return event.content
      .map((block) => (block.type === "tool_use" ? block.name : block.type))
      .join(", ");
  }
  return "";
}

function ToolCallRow({
  session,
  agentPk,
  call,
}: {
  readonly session: SessionDetail;
  readonly agentPk: number;
  readonly call: ToolCallView;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div class={`tool-call ${call.isError ? "failed" : ""}`}>
      <button type="button" class="link" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {call.name}
      </button>
      {call.isError && <span class="badge errored">! 실패</span>}
      {call.resultEventId === undefined && <span class="muted small">결과 없음</span>}
      <span class="muted small">{formatDuration(call.startedAtUs, call.endedAtUs)}</span>
      {call.subagentPk !== undefined && (
        <a href={hrefOf(session.agent, session.id, call.subagentPk)}>Subagent 보기</a>
      )}
      {open && <ToolCallDetail agentPk={agentPk} call={call} />}
    </div>
  );
}

function ToolCallDetail({
  agentPk,
  call,
}: {
  readonly agentPk: number;
  readonly call: ToolCallView;
}) {
  const body = useLoad<ToolCallBody>(
    () => api.toolCall(agentPk, call.llmCallId, call.ordinal),
    [agentPk, call.llmCallId, call.ordinal],
  );
  if (!body.data) return <Status loaded={body} />;
  return (
    <div class="tool-body">
      <div class="block-title">인자</div>
      <pre>{prettyJson(body.data.input ?? {})}</pre>
      <div class="block-title">결과</div>
      <pre>{body.data.output === undefined ? "(결과 없음)" : prettyJson(body.data.output)}</pre>
    </div>
  );
}

function CompactionCard({
  agentPk,
  compaction,
}: {
  readonly agentPk: number;
  readonly compaction: CompactionView;
}) {
  const [open, setOpen] = useState(false);
  return (
    <article class="card compaction">
      <header>
        <strong>Compaction</strong>
        <span>{compaction.trigger ?? "trigger 없음"}</span>
        <span class="muted">{compaction.model ?? ""}</span>
        <span class="muted">{formatDuration(compaction.startedAtUs, compaction.endedAtUs)}</span>
        <span class="spacer" />
        {compaction.summaryEventId && (
          <button type="button" onClick={() => setOpen(!open)}>
            요약
          </button>
        )}
      </header>
      <table class="compact">
        <thead>
          <tr>
            <UsageHeaders />
          </tr>
        </thead>
        <tbody>
          <tr>
            <UsageCells usage={compaction.usage} />
          </tr>
        </tbody>
      </table>
      {open && compaction.summaryEventId && (
        <EventText agentPk={agentPk} eventId={compaction.summaryEventId} field="text" />
      )}
    </article>
  );
}

function App() {
  const route = useRoute();
  return route.page === "sessions" ? <SessionsPage /> : <SessionPage route={route} />;
}

render(<App />, document.getElementById("app") as HTMLElement);
