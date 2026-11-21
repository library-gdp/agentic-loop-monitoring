import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginLogger, PluginTransportUnit, SessionLogEvent } from "@agentoscope/plugin-api";
import { createCollector } from "../src/collector";
import { loadState, STATE_FILE } from "../src/state";

const directories: string[] = [];

export function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "agentoscope-opencode-"));
    directories.push(directory);
    return directory;
}

export function cleanUp(): void {
    for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
}

export interface Log {
    readonly level: "info" | "warn" | "error";
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
}

export function recordingLogger(logs: Log[]): PluginLogger {
    const log =
        (level: Log["level"]) => (message: string, details?: Readonly<Record<string, unknown>>) => {
            logs.push({ level, message, ...(details === undefined ? {} : { details }) });
        };
    return { info: log("info"), warn: log("warn"), error: log("error") };
}

export interface Collected {
    readonly units: PluginTransportUnit[];
    readonly logs: Log[];
}

/** 상태 디렉터리의 상태에서 이어 한 번 수집합니다. */
export async function collectOnce(
    dbPath: string,
    stateDirectory: string,
    batchSize = 3,
): Promise<Collected> {
    const units: PluginTransportUnit[] = [];
    const logs: Log[] = [];
    mkdirSync(stateDirectory, { recursive: true });
    const statePath = join(stateDirectory, STATE_FILE);
    const { state } = await loadState(statePath, dbPath);
    const collector = createCollector({
        dbPath,
        statePath,
        state,
        submit: (unit) => units.push(unit),
        logger: recordingLogger(logs),
        stopping: () => false,
        batchSize,
    });
    try {
        await collector.collect();
    } finally {
        collector.close();
    }
    return { units, logs };
}

/** Transport Unit을 비교하기 쉬운 한 줄로 줄입니다. */
export function outline(unit: PluginTransportUnit): string {
    const events = unit.events.map(describe).join(" ");
    return `${unit.agent.id} ${unit.turn.id}@${unit.turn.position}: ${events}`;
}

function describe(event: SessionLogEvent): string {
    switch (event.type) {
        case "assistant_message": {
            const blocks = event.content
                .map((block) =>
                    block.type === "tool_use" ? `tool_use(${block.name})` : block.type,
                )
                .join(",");
            const end = event.error ? `error(${event.error.code})` : (event.stop_reason ?? "-");
            return `assistant[${blocks}]/${end}`;
        }
        case "compaction":
            return `compaction(${event.trigger ?? "-"})`;
        case "tool_result":
            return `tool_result(${event.tool_use_id}${event.is_error ? ",error" : ""})`;
        default:
            return event.type;
    }
}
