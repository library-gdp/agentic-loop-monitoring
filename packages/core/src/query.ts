import type { JsonObject } from "@agentoscope/plugin-api";
import { KNOWN_EVENT_TYPES, toolUseBlocks } from "./derive";
import { isRecord, type Mutable, parseRecord } from "./json";
import type {
    AgentRef,
    AgentSummary,
    EventRef,
    InputEvent,
    LlmCall,
    LlmCallError,
    LlmCallFilter,
    LlmCallListItem,
    LlmCallRef,
    Loop,
    SessionDetail,
    SessionFilter,
    SessionRef,
    SessionSummary,
    ToolCall,
    ToolCallDetail,
    ToolCallRef,
    TurnDetail,
    TurnRef,
    TurnSummary,
} from "./model";
import type {
    AgentRecord,
    EventSegment,
    Repository,
    StoredAgent,
    StoredLlmCall,
    StoredSession,
    StoredTurn,
    StoredTurnTime,
} from "./repository";
import { compareTurns } from "./turn-order";
import { sumUsage } from "./usage";

/** 목록에 보이는 프롬프트 앞부분의 길이(문자 수)입니다. */
export const PROMPT_PREVIEW_LENGTH = 200;
/** Session 목록을 한 번에 돌려주는 최대 수입니다. */
export const MAX_SESSION_PAGE_SIZE = 500;

/**
 * Visualization이 기록된 데이터를 조회하기 위한 API입니다.
 * 찾는 대상이 없으면 undefined를 돌려줍니다.
 */
export interface QueryApi {
    /** Session 목록입니다. 시작 시각이 늦은 순이며, Turn이 없는 Session은 처음 받은 시각으로 정렬합니다. */
    listSessions(filter: SessionFilter): readonly SessionSummary[];
    /** Session과 그 Agent 트리입니다. */
    getSession(ref: SessionRef): SessionDetail | undefined;
    /** Agent의 Turn 목록입니다. Turn 순서를 따릅니다. */
    listTurns(ref: AgentRef): readonly TurnSummary[] | undefined;
    /** Turn의 Loop, LLM Call, Tool Call, Compaction입니다. 큰 본문은 담지 않습니다. */
    getTurn(ref: TurnRef): TurnDetail | undefined;
    /** Session의 LLM Call입니다. 오류로 끝난 LLM Call, Stop Reason, Agent로 거를 수 있습니다. */
    listLlmCalls(ref: SessionRef, filter?: LlmCallFilter): readonly LlmCallListItem[] | undefined;
    /** Tool Call과 그 인자, 결과입니다. */
    getToolCall(ref: ToolCallRef): ToolCallDetail | undefined;
    /**
     * LLM Call의 input에 든 Session Log Event를 하나씩 돌려줍니다. 끝까지 읽거나 return()을 불러야 합니다.
     * input은 같은 Agent에서 그 LLM Call 앞에 있는 Session Log Event이며, 앞에 Compaction이 있으면
     * 가장 가까운 compaction부터입니다. Core가 모르는 type은 넣지 않습니다.
     */
    iterateLlmCallInput(ref: LlmCallRef): Iterable<InputEvent> | undefined;
    /** Session Log Event의 JSON 원문입니다. LLM Call의 output, Tool Call의 결과, 요약, 프롬프트를 읽을 때 씁니다. */
    getEventBody(ref: EventRef): string | undefined;
}

export function createQueryApi(repository: Repository): QueryApi {
    return new DefaultQueryApi(repository);
}

interface ResolvedAgent {
    readonly session: StoredSession;
    readonly agent: AgentRecord;
}

class DefaultQueryApi implements QueryApi {
    readonly #repository: Repository;

    constructor(repository: Repository) {
        this.#repository = repository;
    }

    listSessions(filter: SessionFilter): readonly SessionSummary[] {
        const limit = Math.min(Math.max(Math.trunc(filter.limit), 1), MAX_SESSION_PAGE_SIZE);
        const offset = Math.max(Math.trunc(filter.offset), 0);
        return this.#repository
            .listSessions({ ...filter, limit, offset })
            .map((session) => this.#detail(session).summary);
    }

    getSession(ref: SessionRef): SessionDetail | undefined {
        const session = this.#repository.findSession(ref);
        if (session === undefined) return undefined;
        const { summary, agents } = this.#detail(session);
        return { ...summary, agents };
    }

    listTurns(ref: AgentRef): readonly TurnSummary[] | undefined {
        const resolved = this.#resolve(ref);
        if (resolved === undefined) return undefined;
        return [...this.#repository.listTurns(resolved.agent.pk, PROMPT_PREVIEW_LENGTH)]
            .sort(compareTurns)
            .map(toTurnSummary);
    }

    getTurn(ref: TurnRef): TurnDetail | undefined {
        const resolved = this.#resolve(ref);
        if (resolved === undefined) return undefined;
        const key = { agentPk: resolved.agent.pk, turnId: ref.turnId };
        const turn = this.#repository.findTurn(key, PROMPT_PREVIEW_LENGTH);
        if (turn === undefined) return undefined;

        const prompt = parseRecord(
            this.#repository.getEventBody(resolved.session.pk, ref.turnId) ?? "",
        )?.text;
        const toolCallsByLlmCall = new Map<string, ToolCall[]>();
        for (const call of this.#repository.listToolCalls(key)) {
            const calls = toolCallsByLlmCall.get(call.llmCallId);
            if (calls === undefined) toolCallsByLlmCall.set(call.llmCallId, [call]);
            else calls.push(call);
        }
        const loops = this.#repository.listLlmCalls(key).map((stored): Loop => {
            const llmCall = toLlmCall(stored);
            const toolCalls = toolCallsByLlmCall.get(llmCall.id) ?? [];
            let endedAtUs = llmCall.endedAtUs;
            for (const call of toolCalls) {
                if (call.endedAtUs !== undefined && call.endedAtUs > endedAtUs) {
                    endedAtUs = call.endedAtUs;
                }
            }
            return {
                id: llmCall.id,
                llmCall,
                toolCalls,
                startedAtUs: llmCall.startedAtUs,
                endedAtUs,
            };
        });
        return {
            ...toTurnSummary(turn),
            prompt: typeof prompt === "string" ? prompt : "",
            loops,
            compactions: this.#repository.listCompactions(key),
        };
    }

    listLlmCalls(
        ref: SessionRef,
        filter: LlmCallFilter = {},
    ): readonly LlmCallListItem[] | undefined {
        const session = this.#repository.findSession(ref);
        if (session === undefined) return undefined;
        let agentPk: number | undefined;
        if (filter.agentId !== undefined) {
            const agent = this.#repository.findAgent(session.pk, filter.agentId);
            if (agent === undefined) return [];
            agentPk = agent.pk;
        }
        return this.#repository
            .listSessionLlmCalls(session.pk, {
                ...(agentPk === undefined ? {} : { agentPk }),
                ...(filter.failed === undefined ? {} : { failed: filter.failed }),
                ...(filter.stopReason === undefined ? {} : { stopReason: filter.stopReason }),
            })
            .map((stored) => ({ ...toLlmCall(stored), agentId: stored.agentId }));
    }

    getToolCall(ref: ToolCallRef): ToolCallDetail | undefined {
        const resolved = this.#resolve(ref);
        if (resolved === undefined) return undefined;
        const call = this.#repository.findToolCall(resolved.agent.pk, ref.llmCallId, ref.ordinal);
        if (call === undefined) return undefined;

        const request = parseRecord(
            this.#repository.getEventBody(resolved.session.pk, ref.llmCallId) ?? "",
        );
        const input = toolUseBlocks(request?.content)[ref.ordinal]?.input;
        const detail: Mutable<ToolCallDetail> = {
            ...call,
            input: isRecord(input) ? (input as JsonObject) : {},
        };
        if (call.resultEventId !== undefined) {
            const result = parseRecord(
                this.#repository.getEventBody(resolved.session.pk, call.resultEventId) ?? "",
            );
            const output = result?.output;
            if (typeof output === "string") detail.output = output;
            else if (isRecord(output)) detail.output = output as JsonObject;
        }
        return detail;
    }

    iterateLlmCallInput(ref: LlmCallRef): Iterable<InputEvent> | undefined {
        const resolved = this.#resolve(ref);
        if (resolved === undefined) return undefined;
        const agentPk = resolved.agent.pk;
        const target = this.#repository.findLlmCall(agentPk, ref.llmCallId);
        if (target === undefined) return undefined;

        const turns = [...this.#repository.listTurnOrderKeys(agentPk)].sort(compareTurns);
        const order = new Map(turns.map((turn, index) => [turn.turnId, index]));
        const targetIndex = order.get(target.turnId);
        if (targetIndex === undefined) return undefined;

        // 범위의 시작은 범위의 끝보다 앞에 있는 가장 가까운 compaction입니다.
        let start: { readonly index: number; readonly position: number } | undefined;
        for (const compaction of this.#repository.listCompactionPositions(agentPk)) {
            const index = order.get(compaction.turnId);
            if (index === undefined) continue;
            const before =
                index < targetIndex ||
                (index === targetIndex && compaction.position < target.position);
            if (!before) continue;
            const closer =
                start === undefined ||
                index > start.index ||
                (index === start.index && compaction.position > start.position);
            if (closer) start = { index, position: compaction.position };
        }

        const segments: EventSegment[] = [];
        for (let index = start?.index ?? 0; index <= targetIndex; index += 1) {
            const turn = turns[index];
            if (turn === undefined) continue;
            segments.push({
                turnId: turn.turnId,
                fromPosition: start !== undefined && index === start.index ? start.position : 0,
                ...(index === targetIndex ? { toPosition: target.position } : {}),
            });
        }
        return this.#repository.iterateEvents(agentPk, segments, KNOWN_EVENT_TYPES);
    }

    getEventBody(ref: EventRef): string | undefined {
        const session = this.#repository.findSession(ref);
        if (session === undefined) return undefined;
        return this.#repository.getEventBody(session.pk, ref.eventId);
    }

    #resolve(ref: AgentRef): ResolvedAgent | undefined {
        const session = this.#repository.findSession(ref);
        if (session === undefined) return undefined;
        const agent = this.#repository.findAgent(session.pk, ref.agentId);
        if (agent === undefined) return undefined;
        return { session, agent };
    }

    #detail(session: StoredSession): {
        summary: SessionSummary;
        agents: AgentSummary[];
    } {
        const agents = this.#repository.listAgents(session.pk);
        const times = this.#repository.listTurnTimes(session.pk);
        const agentSummaries = agents.map((agent) => summarizeAgent(agent, times));

        const summary: Mutable<SessionSummary> = {
            agentKind: session.agentKind,
            sessionId: session.sessionId,
            firstReceivedAtUs: session.firstReceivedAtUs,
            agentCount: agentSummaries.length,
            turnCount: times.length,
            usage: sumUsage(agents.map((agent) => agent.usage)),
        };
        if (session.cwd !== undefined) summary.cwd = session.cwd;
        if (session.host !== undefined) summary.host = session.host;
        for (const agent of agentSummaries) {
            if (
                agent.startedAtUs !== undefined &&
                (summary.startedAtUs === undefined || agent.startedAtUs < summary.startedAtUs)
            ) {
                summary.startedAtUs = agent.startedAtUs;
            }
            if (
                agent.endedAtUs !== undefined &&
                (summary.endedAtUs === undefined || agent.endedAtUs > summary.endedAtUs)
            ) {
                summary.endedAtUs = agent.endedAtUs;
            }
        }
        return { summary, agents: agentSummaries };
    }
}

/** Agent의 started_at은 첫 Turn의 started_at, ended_at은 Turn 순서로 마지막 Turn의 ended_at입니다. */
function summarizeAgent(agent: StoredAgent, times: readonly StoredTurnTime[]): AgentSummary {
    const turns = times.filter((time) => time.agentPk === agent.pk).sort(compareTurns);
    const summary: Mutable<AgentSummary> = {
        agentId: agent.agentId,
        turnCount: turns.length,
        usage: agent.usage,
    };
    if (agent.parentId !== undefined) summary.parentId = agent.parentId;
    const first = turns[0];
    const last = turns[turns.length - 1];
    if (first !== undefined) summary.startedAtUs = first.startedAtUs;
    if (last !== undefined) summary.endedAtUs = last.endedAtUs;
    return summary;
}

function toTurnSummary(turn: StoredTurn): TurnSummary {
    return {
        turnId: turn.turnId,
        status: turn.status,
        promptPreview: turn.promptPreview,
        promptLength: turn.promptLength,
        startedAtUs: turn.startedAtUs,
        endedAtUs: turn.endedAtUs,
        loopCount: turn.loopCount,
        failedLlmCallCount: turn.failedLlmCallCount,
        toolCallCount: turn.toolCallCount,
        compactionCount: turn.compactionCount,
        usage: turn.usage,
    };
}

function toLlmCall(stored: StoredLlmCall): LlmCall {
    const { agentId: _agentId, errorJson, ...call } = stored;
    const error = errorJson === undefined ? undefined : toLlmCallError(errorJson);
    return error === undefined ? call : { ...call, error };
}

function toLlmCallError(json: string): LlmCallError | undefined {
    const error = parseRecord(json);
    if (error === undefined || typeof error.message !== "string") return undefined;
    const result: Mutable<LlmCallError> = { message: error.message };
    if (typeof error.code === "string") result.code = error.code;
    if (typeof error.status_code === "number" && Number.isSafeInteger(error.status_code)) {
        result.statusCode = error.status_code;
    }
    if (typeof error.will_retry === "boolean") result.willRetry = error.will_retry;
    return result;
}
