/** Main Server의 Visualization 라우트를 부릅니다(docs/002.implementation/011.VISUALIZATION.md의 라우트). */

import type {
    AgentRef,
    SessionDetail,
    SessionRef,
    SessionSummary,
    ToolCallDetail,
    TurnNodes,
    TurnSummary,
} from "@agentoscope/core";

/** 접근 토큰이 없거나 맞지 않습니다. */
export class UnauthorizedError extends Error {
    override readonly name = "UnauthorizedError";
}

export class NotFoundError extends Error {
    override readonly name = "NotFoundError";
}

const segment = encodeURIComponent;

function sessionPath(ref: SessionRef): string {
    return `/api/sessions/${segment(ref.agentKind)}/${segment(ref.sessionId)}`;
}

function agentPath(ref: AgentRef): string {
    return `${sessionPath(ref)}/agents/${segment(ref.agentId)}`;
}

async function request(path: string, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(path, {
        credentials: "same-origin",
        ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 401) throw new UnauthorizedError("unauthorized");
    if (response.status === 404) throw new NotFoundError(path);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response;
}

async function json<T>(path: string): Promise<T> {
    return (await (await request(path)).json()) as T;
}

export interface SessionQuery {
    readonly agent?: string;
    readonly cwd?: string;
    readonly host?: string;
    readonly limit: number;
    readonly offset: number;
}

export function listSessions(query: SessionQuery): Promise<SessionSummary[]> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== "") params.set(key, String(value));
    }
    return json(`/api/sessions?${params}`);
}

export function getSession(ref: SessionRef): Promise<SessionDetail> {
    return json(sessionPath(ref));
}

export function listTurns(ref: AgentRef): Promise<TurnSummary[]> {
    return json(`${agentPath(ref)}/turns`);
}

export function getTurnNodes(ref: AgentRef, turnId: string): Promise<TurnNodes> {
    return json(`${agentPath(ref)}/turns/${segment(turnId)}/nodes`);
}

export function getToolCall(
    ref: AgentRef,
    llmCallId: string,
    ordinal: number,
): Promise<ToolCallDetail> {
    return json(`${agentPath(ref)}/llm-calls/${segment(llmCallId)}/tool-calls/${ordinal}`);
}

/** Session Log Event 하나의 JSON 원문을 객체로 읽습니다. */
export function getEventBody(ref: SessionRef, eventId: string): Promise<Record<string, unknown>> {
    return json(`${sessionPath(ref)}/events/${segment(eventId)}`);
}

/** LLM Call의 input에 든 Session Log Event 하나입니다. */
export interface InputItem {
    readonly eventId: string;
    readonly turnId: string;
    readonly position: number;
    readonly type: string;
    readonly timestampUs: number;
    /** 원문 JSON 텍스트의 길이(문자 수)입니다. */
    readonly size: number;
    readonly body: Record<string, unknown>;
}

/** LLM Call의 input을 스트리밍으로 읽어 한 항목씩 넘깁니다. */
export async function readLlmCallInput(
    ref: AgentRef,
    llmCallId: string,
    onItem: (item: InputItem) => void,
    signal: AbortSignal,
): Promise<void> {
    const response = await request(
        `${agentPath(ref)}/llm-calls/${segment(llmCallId)}/input`,
        signal,
    );
    const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (reader === undefined) return;
    let buffer = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line !== "") onItem(JSON.parse(line) as InputItem);
            newline = buffer.indexOf("\n");
        }
    }
}
