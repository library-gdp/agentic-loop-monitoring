export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

export type TurnStatus = "completed" | "interrupted" | "errored" | "in_progress";

export interface SessionSummary {
  agent: string;
  id: string;
  cwd?: string;
  host?: string;
  agentCount: number;
  turnCount: number;
  unfinishedTurnCount: number;
  firstPrompt?: string;
  startedAtUs?: number;
  endedAtUs?: number;
  usage: TokenUsage;
}

export interface AgentSummary {
  pk: number;
  id: string;
  parentId?: string;
  turnCount: number;
  startedAtUs?: number;
  endedAtUs?: number;
  usage: TokenUsage;
}

export interface SessionDetail extends SessionSummary {
  agents: AgentSummary[];
}

export interface TurnSummary {
  id: string;
  prompt: string;
  promptTruncated: boolean;
  status: TurnStatus;
  startedAtUs: number;
  endedAtUs: number;
  loopCount: number;
  toolCallCount: number;
  failedLlmCallCount: number;
  compactionCount: number;
  usage: TokenUsage;
}

export interface ToolCallView {
  ordinal: number;
  id: string;
  llmCallId: string;
  name: string;
  resultEventId?: string;
  isError?: boolean;
  startedAtUs: number;
  endedAtUs?: number;
  subagentId?: string;
  subagentPk?: number;
}

export interface LlmCallView {
  id: string;
  position: number;
  model?: string;
  stopReason?: string;
  failed: boolean;
  errorMessage?: string;
  attempt?: number;
  startedAtUs: number;
  startedAtEstimated: boolean;
  endedAtUs: number;
  usage: TokenUsage;
}

export interface LoopView {
  id: string;
  llmCall: LlmCallView;
  toolCalls: ToolCallView[];
  startedAtUs: number;
  endedAtUs: number;
}

export interface CompactionView {
  id: string;
  position: number;
  summaryEventId?: string;
  trigger?: "auto" | "manual";
  contextTokensBefore?: number;
  model?: string;
  startedAtUs: number;
  endedAtUs?: number;
  usage: TokenUsage;
}

export interface TurnDetail extends TurnSummary {
  loops: LoopView[];
  compactions: CompactionView[];
}

export interface ToolCallBody {
  input?: unknown;
  output?: unknown;
  isError?: boolean;
}

/** Session Log Event 원문입니다. 모르는 종류와 필드도 그대로 옵니다. */
export interface RawEvent {
  event_id: string;
  type: string;
  timestamp: string;
  text?: string;
  content?: RawBlock[];
  output?: unknown;
  error?: { message: string; code?: string; status_code?: number };
  [key: string]: unknown;
}

export interface RawBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  return (await response.json()) as T;
}

const part = encodeURIComponent;

export const api = {
  sessions(filter: { agent?: string; cwd?: string; offset: number; limit: number }) {
    const params = new URLSearchParams({
      offset: String(filter.offset),
      limit: String(filter.limit),
    });
    if (filter.agent) params.set("agent", filter.agent);
    if (filter.cwd) params.set("cwd", filter.cwd);
    return get<SessionSummary[]>(`/api/sessions?${params}`);
  },
  session: (agent: string, id: string) =>
    get<SessionDetail>(`/api/sessions/${part(agent)}/${part(id)}`),
  turns: (agentPk: number) => get<TurnSummary[]>(`/api/agents/${agentPk}/turns`),
  turn: (agentPk: number, turnId: string) =>
    get<TurnDetail>(`/api/agents/${agentPk}/turns/${part(turnId)}`),
  event: (agentPk: number, eventId: string) =>
    get<RawEvent>(`/api/agents/${agentPk}/events/${part(eventId)}`),
  toolCall: (agentPk: number, llmCallId: string, ordinal: number) =>
    get<ToolCallBody>(`/api/agents/${agentPk}/tool-calls/${part(llmCallId)}/${ordinal}`),
  async deleteSession(agent: string, id: string) {
    const response = await fetch(`/api/sessions/${part(agent)}/${part(id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`${response.status} delete session`);
  },
  /** input을 한 Session Log Event씩 받습니다. 긴 input도 받는 대로 화면에 나타납니다. */
  async streamInput(agentPk: number, llmCallId: string, onEvent: (event: RawEvent) => void) {
    const path = `/api/agents/${agentPk}/llm-calls/${part(llmCallId)}/input`;
    const response = await fetch(path);
    if (!response.ok || !response.body) throw new Error(`${response.status} ${path}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line) onEvent(JSON.parse(line) as RawEvent);
    }
  },
};
