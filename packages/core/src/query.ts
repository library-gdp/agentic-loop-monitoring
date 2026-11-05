import type { LlmCallError, ToolUseBlock } from "@alm/protocol";
import type {
  LoopView,
  SessionDetail,
  SessionFilter,
  SessionSummary,
  ToolCallBody,
  TurnDetail,
  TurnSummary,
} from "./model";
import type { Repository } from "./repository";

/** Visualization이 기록된 데이터를 조회하기 위한 API입니다. */
export class QueryApi {
  constructor(private readonly repository: Repository) {}

  listSessions(filter: SessionFilter): readonly SessionSummary[] {
    return this.repository.listSessions(filter);
  }

  getSession(agentKind: string, sessionId: string): SessionDetail | undefined {
    const summary = this.repository.findSessionSummary(agentKind, sessionId);
    if (!summary) return undefined;
    return { ...summary, agents: this.repository.listAgents(agentKind, sessionId) };
  }

  listTurns(agentPk: number): readonly TurnSummary[] {
    return this.repository.listTurns(agentPk);
  }

  getTurn(agentPk: number, turnId: string): TurnDetail | undefined {
    const key = { agentPk, turnId };
    const summary = this.repository.findTurn(key);
    if (!summary) return undefined;
    const toolCalls = this.repository.listToolCalls(key);
    const loops: LoopView[] = this.repository.listLlmCalls(key).map((llmCall) => {
      const calls = toolCalls.filter((call) => call.llmCallId === llmCall.id);
      const endedAtUs = Math.max(llmCall.endedAtUs, ...calls.map((call) => call.endedAtUs ?? 0));
      const failed = llmCall.failed ? this.#errorMessage(agentPk, llmCall.id) : undefined;
      return {
        id: llmCall.id,
        llmCall: failed === undefined ? llmCall : { ...llmCall, errorMessage: failed },
        toolCalls: calls,
        startedAtUs: llmCall.startedAtUs,
        endedAtUs,
      };
    });
    return { ...summary, loops, compactions: this.repository.listCompactions(key) };
  }

  /** LLM Call의 input을 Session Log Event JSON 원문으로 하나씩 돌려줍니다. */
  iterateLlmCallInput(agentPk: number, llmCallId: string): Iterable<string> | undefined {
    const target = this.repository.findLlmCallCursor(agentPk, llmCallId);
    if (!target) return undefined;
    const compaction = this.repository.findNearestCompaction(agentPk, target);
    return this.repository.iterateEventBodies(agentPk, compaction, target);
  }

  /** LLM Call의 assistant_message JSON 원문입니다. */
  getLlmCallOutput(agentPk: number, llmCallId: string): string | undefined {
    return this.repository.findEventBody(agentPk, llmCallId);
  }

  getEventBody(agentPk: number, eventId: string): string | undefined {
    return this.repository.findEventBody(agentPk, eventId);
  }

  getToolCallBody(agentPk: number, llmCallId: string, ordinal: number): ToolCallBody | undefined {
    const call = this.repository.findToolCall(agentPk, llmCallId, ordinal);
    if (!call) return undefined;
    const request = this.repository.findEventBody(agentPk, llmCallId);
    const content = request ? (JSON.parse(request) as { content: unknown[] }).content : [];
    const blocks = content.filter(
      (block): block is ToolUseBlock => (block as { type?: string }).type === "tool_use",
    );
    const resultBody = call.resultEventId
      ? this.repository.findEventBody(agentPk, call.resultEventId)
      : undefined;
    const result = resultBody
      ? (JSON.parse(resultBody) as { output?: unknown; is_error?: boolean })
      : undefined;
    return {
      input: blocks[ordinal]?.input,
      ...(result?.output === undefined ? {} : { output: result.output }),
      ...(result?.is_error === undefined ? {} : { isError: result.is_error }),
    };
  }

  deleteSession(agentKind: string, sessionId: string): boolean {
    return this.repository.deleteSession(agentKind, sessionId);
  }

  #errorMessage(agentPk: number, llmCallId: string): string | undefined {
    const body = this.repository.findEventBody(agentPk, llmCallId);
    if (!body) return undefined;
    return (JSON.parse(body) as { error?: LlmCallError }).error?.message;
  }
}
