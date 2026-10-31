import type { PluginTransportUnit } from "@alm/plugin-api";
import type { EventRow } from "../src/session-machine";

/** OpenCode 1.19.5가 기록하는 순서대로 `event` 행을 만듭니다. */
export class Log {
  readonly rows: EventRow[] = [];
  #clock = 1_000;

  #push(type: string, data: unknown): void {
    const seq = this.rows.length;
    this.rows.push({ id: `evt_${seq}`, seq, type, data: JSON.stringify(data) });
  }

  now(): number {
    this.#clock += 1_000;
    return this.#clock;
  }

  message(info: Record<string, unknown>): void {
    this.#push("message.updated.1", { sessionID: "ses_a", info: { sessionID: "ses_a", ...info } });
  }

  part(id: string, messageID: string, part: Record<string, unknown>): void {
    this.#push("message.part.updated.1", {
      sessionID: "ses_a",
      part: { id, messageID, sessionID: "ses_a", ...part },
      time: this.now(),
    });
  }

  raw(type: string, data: unknown): void {
    this.#push(type, data);
  }

  user(id: string, parts: Record<string, unknown>[]): void {
    this.message({ id, role: "user", time: { created: this.now() } });
    parts.forEach((part, index) => {
      this.part(`prt_${id}_${index}`, id, part);
    });
  }

  assistantStart(id: string, parentID: string, extra: Record<string, unknown> = {}): number {
    const created = this.now();
    this.message({
      id,
      role: "assistant",
      parentID,
      modelID: "model-a",
      time: { created },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...extra,
    });
    return created;
  }

  stepStart(messageID: string): void {
    this.part(`prt_${messageID}_start`, messageID, { type: "step-start" });
  }

  text(messageID: string, text: string, type = "text"): void {
    const start = this.now();
    const id = `prt_${messageID}_${type}`;
    this.part(id, messageID, { type, text: "", time: { start } });
    this.part(id, messageID, { type, text, time: { start, end: this.now() } });
  }

  tool(
    messageID: string,
    callID: string,
    tool: string,
    input: Record<string, unknown>,
    state: Record<string, unknown>,
  ): void {
    const id = `prt_${callID}`;
    this.part(id, messageID, {
      type: "tool",
      callID,
      tool,
      state: { status: "pending", input: {} },
    });
    const start = this.now();
    this.part(id, messageID, {
      type: "tool",
      callID,
      tool,
      state: { status: "running", input, time: { start } },
    });
    this.part(id, messageID, {
      type: "tool",
      callID,
      tool,
      state: { input, time: { start, end: this.now() }, ...state },
    });
  }

  stepFinish(messageID: string, reason: string, input = 100, output = 10): void {
    this.part(`prt_${messageID}_finish`, messageID, {
      type: "step-finish",
      reason,
      tokens: { input, output, reasoning: 1, cache: { read: 50, write: 0 } },
    });
  }

  assistantEnd(
    id: string,
    parentID: string,
    created: number,
    extra: Record<string, unknown> = {},
  ): void {
    this.message({
      id,
      role: "assistant",
      parentID,
      modelID: "model-a",
      time: { created, completed: this.now() },
      ...extra,
    });
  }

  /** LLM Call 하나를 끝까지 기록합니다. */
  llm(id: string, parentID: string, finish: string, write: () => void): void {
    const created = this.assistantStart(id, parentID);
    this.stepStart(id);
    write();
    this.stepFinish(id, finish);
    this.assistantEnd(id, parentID, created, { finish });
  }
}

export function events(units: readonly PluginTransportUnit[]) {
  return units.flatMap((unit, unitIndex) =>
    unit.events.map((event, index) => ({
      ...event,
      unitIndex,
      turn: unit.turn.id,
      position: unit.turn.position + index,
    })),
  );
}

export function types(units: readonly PluginTransportUnit[]): string[] {
  return events(units).map((event) => event.type);
}
