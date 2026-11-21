/**
 * Plugin의 상태(session마다 수집한 위치와 변환 상태)를 상태 디렉터리의 JSON 파일에 저장합니다.
 */

import { renameSync, writeFileSync } from "node:fs";
import { type AgentState, newAgentState } from "./convert";

export const STATE_VERSION = 1;
export const STATE_FILE = "state.json";

export interface PluginState {
    readonly version: typeof STATE_VERSION;
    /** 수집하는 OpenCode DB 파일의 경로입니다. 바뀌면 상태를 버리고 처음부터 수집합니다. */
    readonly db: string;
    /** OpenCode session id(= aggregate_id)마다의 상태입니다. */
    readonly sessions: Record<string, AgentState>;
}

export function emptyState(db: string): PluginState {
    return { version: STATE_VERSION, db, sessions: {} };
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 저장한 AgentState의 모양을 확인합니다. 맞지 않으면 그 session을 처음부터 수집합니다. */
function isAgentState(value: unknown): value is AgentState {
    if (typeof value !== "object" || value === null) return false;
    const state = value as Record<string, unknown>;
    return (
        typeof state.seq === "number" &&
        Number.isSafeInteger(state.seq) &&
        Array.isArray(state.turns) &&
        state.turns.every(
            (turn) =>
                typeof turn === "object" &&
                turn !== null &&
                typeof turn.id === "string" &&
                typeof turn.next === "number" &&
                isStringArray(turn.messages),
        ) &&
        isStringArray(state.users) &&
        isStringArray(state.skipped) &&
        isStringArray(state.emitted) &&
        isStringArray(state.closed)
    );
}

export type LoadResult =
    | { readonly state: PluginState; readonly problem?: undefined }
    | { readonly state: PluginState; readonly problem: string };

/**
 * 상태 파일을 읽습니다. 파일이 없으면 빈 상태를, 읽을 수 없거나 다른 DB의 상태이면 빈 상태와 그 이유를 돌려줍니다.
 * 수집한 위치를 잃으면 처음부터 다시 수집하며, 이미 보낸 Session Log Event는 Main Server가 걸러냅니다.
 */
export async function loadState(path: string, db: string): Promise<LoadResult> {
    const file = Bun.file(path);
    if (!(await file.exists())) return { state: emptyState(db) };
    let document: unknown;
    try {
        document = JSON.parse(await file.text());
    } catch (error) {
        return { state: emptyState(db), problem: `cannot parse the state file: ${String(error)}` };
    }
    const saved = document as Partial<PluginState> | null;
    if (saved?.version !== STATE_VERSION || typeof saved.sessions !== "object") {
        return { state: emptyState(db), problem: "the state file has an unknown format" };
    }
    if (saved.db !== db) {
        return { state: emptyState(db), problem: "the state file belongs to another database" };
    }
    const sessions: Record<string, AgentState> = {};
    for (const [id, session] of Object.entries(saved.sessions ?? {})) {
        sessions[id] = isAgentState(session) ? session : newAgentState();
    }
    return { state: { version: STATE_VERSION, db, sessions } };
}

/** 상태를 임시 파일에 쓴 뒤 바꿔 넣어, 쓰다 멈춰도 이전 상태가 남게 합니다. */
export function saveState(path: string, state: PluginState): void {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, path);
}
