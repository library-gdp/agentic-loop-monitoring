import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { PluginLogger } from "@alm/plugin-api";
import type { Checkpoint } from "./session-machine";

/** 수집 위치를 읽습니다. 파일이 없거나 손상되었으면 처음부터 다시 수집합니다. */
export function loadState(path: string, logger: PluginLogger): Map<string, Checkpoint> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return new Map();
  }
  try {
    const entries = Object.entries(JSON.parse(text) as Record<string, Checkpoint>);
    if (entries.every(([, value]) => typeof value?.seq === "number")) return new Map(entries);
  } catch {
    // 아래에서 처음부터 다시 수집합니다.
  }
  logger.warn("collection state is damaged; collecting from the beginning", { path });
  return new Map();
}

export function saveState(path: string, serialized: string, logger: PluginLogger): void {
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, serialized, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    logger.error("failed to save collection state", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
