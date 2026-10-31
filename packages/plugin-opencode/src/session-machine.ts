import type { PluginTransportUnit, SessionLogEvent } from "@alm/plugin-api";
import * as v from "valibot";
import {
  compactionTrigger,
  endsTurn,
  isAborted,
  isLlmCall,
  isToolFinished,
  isUserPrompt,
  toCompactionEvents,
  toLlmCallEvents,
  toTimestamp,
  toToolContextText,
  toToolParts,
  userMessageText,
} from "./convert";
import {
  type AssistantInfo,
  MessageRemovedSchema,
  MessageUpdatedSchema,
  PartRemovedSchema,
  PartUpdatedSchema,
  type RawPart,
  type UserInfo,
} from "./records";

export interface EventRow {
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly data: string;
}

export interface TurnCursor {
  readonly id: string;
  /** 다음 Session Log Event의 Turn 안 위치입니다. */
  readonly nextPosition: number;
  /** Turn이 끝났으면 true입니다. 뒤따르는 synthetic 메시지는 다음 프롬프트까지 기다립니다. */
  readonly ended: boolean;
}

/** 다시 시작할 때 이어 읽을 수 있는 session의 수집 위치입니다. */
export interface Checkpoint {
  /** 이 값까지의 행은 모두 넘겼습니다. 없으면 처음부터 읽습니다. */
  readonly seq: number;
  readonly turn?: TurnCursor;
  /** 끝까지 처리한 가장 큰 message id입니다. 그 이하의 message 갱신은 무시합니다. */
  readonly lastMessageId: string;
}

export const INITIAL_CHECKPOINT: Checkpoint = { seq: -1, lastMessageId: "" };

interface Draft<Info> {
  info: Info;
  readonly parts: Map<string, RawPart>;
}

interface HeldContext {
  readonly eventId: string;
  readonly timestampMs: number;
  readonly text: string;
}

export interface SessionMachineOptions {
  readonly session: PluginTransportUnit["session"];
  readonly agent: PluginTransportUnit["agent"];
  readonly submit: (unit: PluginTransportUnit) => void;
  readonly warn: (message: string, details: Record<string, string | number>) => void;
}

/**
 * OpenCode session 하나의 `event` 행을 차례로 받아 Transport Unit으로 바꿉니다.
 * message는 끝나야 변환할 수 있으므로 끝나지 않은 message의 part만 메모리에 둡니다.
 */
export class SessionMachine {
  #checkpoint: Checkpoint;
  #seq: number;
  #turn: TurnCursor | undefined;
  #lastMessageId: string;
  readonly #users = new Map<string, Draft<UserInfo>>();
  #assistant: Draft<AssistantInfo> | undefined;
  #held: HeldContext[] = [];
  /** 요약을 기다리는 compaction의 trigger입니다. */
  #compactionTrigger: "auto" | "manual" | undefined;

  constructor(
    private readonly options: SessionMachineOptions,
    checkpoint: Checkpoint = INITIAL_CHECKPOINT,
  ) {
    this.#checkpoint = checkpoint;
    this.#seq = checkpoint.seq;
    this.#turn = checkpoint.turn;
    this.#lastMessageId = checkpoint.lastMessageId;
  }

  /** 저장할 수집 위치입니다. 메모리에만 있는 message가 있으면 그 앞을 가리킵니다. */
  get checkpoint(): Checkpoint {
    return this.#checkpoint;
  }

  /** 이 행까지 읽었습니다. */
  get seq(): number {
    return this.#seq;
  }

  /** 다음 Session Log Event 없이 멈춘 상태인지입니다. 메모리에 message가 없으면 true입니다. */
  get settled(): boolean {
    return !this.#assistant && this.#users.size === 0 && this.#held.length === 0;
  }

  accept(row: EventRow): void {
    this.#seq = row.seq;
    this.#apply(row);
    if (this.settled) {
      this.#checkpoint = {
        seq: row.seq,
        lastMessageId: this.#lastMessageId,
        ...(this.#turn ? { turn: this.#turn } : {}),
      };
    }
  }

  #apply(row: EventRow): void {
    if (!row.type.endsWith(".1")) return;
    const name = row.type.slice(0, -2);
    if (
      name !== "message.updated" &&
      name !== "message.part.updated" &&
      name !== "message.removed" &&
      name !== "message.part.removed"
    ) {
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(row.data);
    } catch {
      this.options.warn("skipped a record that is not JSON", { seq: row.seq, type: row.type });
      return;
    }
    const schema = {
      "message.updated": MessageUpdatedSchema,
      "message.part.updated": PartUpdatedSchema,
      "message.removed": MessageRemovedSchema,
      "message.part.removed": PartRemovedSchema,
    }[name];
    const parsed = v.safeParse(schema, data);
    if (!parsed.success) {
      this.options.warn("skipped a record it cannot read", { seq: row.seq, type: row.type });
      return;
    }
    if (name === "message.updated") {
      this.#onMessage(v.parse(MessageUpdatedSchema, data).info);
    } else if (name === "message.part.updated") {
      this.#onPart(v.parse(PartUpdatedSchema, data).part as RawPart);
    } else if (name === "message.removed") {
      this.#onMessageRemoved(v.parse(MessageRemovedSchema, data).messageID);
    } else {
      const { messageID, partID } = v.parse(PartRemovedSchema, data);
      this.#draft(messageID)?.parts.delete(partID);
    }
  }

  #draft(messageId: string): Draft<UserInfo | AssistantInfo> | undefined {
    return this.#assistant?.info.id === messageId ? this.#assistant : this.#users.get(messageId);
  }

  #onMessage(info: UserInfo | AssistantInfo): void {
    if (info.role === "user") {
      if (info.id <= this.#lastMessageId || this.#users.has(info.id)) return;
      if (!this.#assistant) this.#flushUsers(info.id);
      this.#users.set(info.id, { info, parts: new Map() });
      return;
    }

    if (this.#assistant?.info.id === info.id) {
      this.#assistant.info = info;
      this.#finishAssistantIfComplete();
      return;
    }
    if (info.id <= this.#lastMessageId) return;
    // 앞 message가 끝나지 않았는데 다음 message가 시작되면 앞 message는 강제 종료로 남은 것입니다.
    if (this.#assistant) this.#finishAssistant();
    this.#assistant = { info, parts: new Map() };
    this.#finishAssistantIfComplete();
  }

  #onPart(part: RawPart): void {
    const draft = this.#draft(part.messageID);
    if (!draft) return;
    draft.parts.set(part.id, part);
    if (draft === this.#assistant) this.#finishAssistantIfComplete();
  }

  #onMessageRemoved(messageId: string): void {
    if (this.#assistant?.info.id === messageId) this.#assistant = undefined;
    this.#users.delete(messageId);
  }

  #finishAssistantIfComplete(): void {
    const draft = this.#assistant;
    if (!draft?.info.time.completed) return;
    // subtask는 message를 끝낸 뒤에 도구의 결과를 기록합니다.
    if (toToolParts(draft.parts.values()).every(isToolFinished)) this.#finishAssistant();
  }

  #finishAssistant(): void {
    const draft = this.#assistant as Draft<AssistantInfo>;
    this.#assistant = undefined;
    const { info } = draft;
    const parts = [...draft.parts.values()];
    this.#flushUsers(info.id);
    this.#lastMessageId = info.id;

    if (info.summary) {
      this.#finishCompaction(info, parts);
    } else if (isLlmCall(parts)) {
      this.#emit(toLlmCallEvents(info, parts));
      if (this.#turn && endsTurn(info, parts)) this.#turn = { ...this.#turn, ended: true };
    } else {
      this.#addContext({
        eventId: info.id,
        timestampMs: info.time.completed ?? info.time.created,
        text: toToolContextText(parts),
      });
      if (isAborted(info)) {
        this.#emit([
          {
            event_id: `${info.id}:interrupted`,
            type: "turn_interrupted",
            timestamp: toTimestamp(info.time.completed ?? info.time.created),
          },
        ]);
      }
    }
  }

  #finishCompaction(info: AssistantInfo, parts: readonly RawPart[]): void {
    const trigger = this.#compactionTrigger;
    this.#compactionTrigger = undefined;
    this.#emit(toCompactionEvents(info, parts, trigger));
    if (this.#turn) {
      const ended = trigger !== "auto" || info.error !== undefined;
      this.#turn = { ...this.#turn, ended };
    }
  }

  /** before보다 작은 id의 user message를 넘깁니다. 그 message의 part는 모두 기록되었습니다. */
  #flushUsers(before: string): void {
    for (const [id, draft] of this.#users) {
      if (id >= before) continue;
      this.#users.delete(id);
      this.#lastMessageId = id;
      this.#flushUser(draft);
    }
  }

  #flushUser(draft: Draft<UserInfo>): void {
    const { info } = draft;
    const parts = [...draft.parts.values()];
    const trigger = compactionTrigger(parts);
    if (trigger) this.#compactionTrigger = trigger;
    if (trigger === "auto") return;
    const text = userMessageText(parts);
    if (trigger === "manual" || isUserPrompt(parts)) {
      this.#turn = { id: info.id, nextPosition: 0, ended: false };
      this.#emit([
        {
          event_id: info.id,
          type: "user_message",
          timestamp: toTimestamp(info.time.created),
          text,
        },
      ]);
      const held = this.#held;
      this.#held = [];
      for (const context of held) this.#addContext(context);
      return;
    }
    if (text !== "") {
      this.#addContext({ eventId: info.id, timestampMs: info.time.created, text });
    }
  }

  /** Turn 밖에서 들어온 내용은 다음 프롬프트의 Turn에 담습니다. Turn을 시작하지 않기 때문입니다. */
  #addContext(context: HeldContext): void {
    if (!this.#turn || this.#turn.ended) {
      this.#held.push(context);
      return;
    }
    this.#emit([
      {
        event_id: context.eventId,
        type: "context_message",
        timestamp: toTimestamp(context.timestampMs),
        text: context.text,
      },
    ]);
  }

  #emit(events: SessionLogEvent[]): void {
    const [first, ...rest] = events;
    if (!first) return;
    if (!this.#turn) {
      this.options.warn("skipped events outside of a turn", { eventId: first.event_id });
      return;
    }
    const { id, nextPosition } = this.#turn;
    this.options.submit({
      session: this.options.session,
      agent: this.options.agent,
      turn: { id, position: nextPosition },
      events: [first, ...rest],
    });
    this.#turn = { ...this.#turn, nextPosition: nextPosition + events.length };
  }
}
