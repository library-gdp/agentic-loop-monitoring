import type {
  AssistantMessageEvent,
  CompactionEvent,
  CompactionSummaryEvent,
  ToolResultEvent,
  ToolUseBlock,
} from "@alm/protocol";
import type {
  DerivedCompaction,
  DerivedLlmCall,
  DerivedToolCall,
  DerivedTurn,
  TurnEventRow,
  TurnStatus,
} from "./model";
import { parseTimestampUs } from "./time";

/** Activity Model 구성 규칙의 버전입니다. 규칙을 바꾸면 올려서 파생 데이터를 다시 만들게 합니다. */
export const DERIVATION_VERSION = 1;

interface OpenToolCall {
  readonly llmCallId: string;
  readonly ordinal: number;
  readonly block: ToolUseBlock;
  readonly startedAtUs: number;
}

type Ending = "final" | "interrupted" | "stopped_by_error" | "manual_compaction" | "open";

/**
 * 한 Turn의 Session Log Event로 파생 데이터를 만듭니다. rows는 position 순이어야 합니다.
 * Turn을 시작한 user_message가 없으면 Turn을 만들 수 없으므로 undefined입니다.
 * status는 이 Turn의 Session Log Event만으로 판단합니다. 다른 Turn을 봐야 하는 errored는 호출하는 쪽이 정합니다.
 */
export function deriveTurn(
  turnId: string,
  rows: Iterable<TurnEventRow>,
): (DerivedTurn & { readonly lastIngestId: number }) | undefined {
  const llmCalls: DerivedLlmCall[] = [];
  const toolCalls: DerivedToolCall[] = [];
  const compactions: DerivedCompaction[] = [];
  const openToolCalls = new Map<string, OpenToolCall[]>();

  let start: TurnEventRow | undefined;
  let previous: TurnEventRow | undefined;
  let last: TurnEventRow | undefined;
  let lastIngestId = 0;
  let ending: Ending = "open";
  let openCompaction: number | undefined;

  for (const row of rows) {
    if (row.position === 0 && row.type === "user_message" && row.eventId === turnId) start = row;
    lastIngestId = Math.max(lastIngestId, row.ingestId);
    ending = "open";

    if (row.position > 0) {
      const body = JSON.parse(row.body) as unknown;
      switch (row.type) {
        case "assistant_message": {
          const event = body as AssistantMessageEvent;
          llmCalls.push(toLlmCall(row, event, previous));
          const blocks = toolUseBlocks(event);
          blocks.forEach((block, ordinal) => {
            const open = { llmCallId: row.eventId, ordinal, block, startedAtUs: row.timestampUs };
            const list = openToolCalls.get(block.tool_use_id);
            if (list) list.push(open);
            else openToolCalls.set(block.tool_use_id, [open]);
            toolCalls.push(toToolCall(open));
          });
          if (event.error) {
            if (event.error.will_retry === false) ending = "stopped_by_error";
          } else if (blocks.length === 0) {
            ending = "final";
          }
          break;
        }
        case "tool_result": {
          const event = body as ToolResultEvent;
          const open = openToolCalls.get(event.tool_use_id)?.shift();
          if (!open) break;
          const index = toolCalls.findIndex(
            (call) => call.llmCallId === open.llmCallId && call.ordinal === open.ordinal,
          );
          toolCalls[index] = {
            ...toToolCall(open),
            resultEventId: row.eventId,
            endedAtUs: row.timestampUs,
            ...(event.is_error === undefined ? {} : { isError: event.is_error }),
            ...(event.subagent_id === undefined ? {} : { subagentId: event.subagent_id }),
          };
          break;
        }
        case "turn_interrupted":
          ending = "interrupted";
          break;
        case "compaction": {
          const event = body as CompactionEvent;
          openCompaction = compactions.length;
          compactions.push({
            id: row.eventId,
            position: row.position,
            startedAtUs: row.timestampUs,
            ...(event.trigger === undefined ? {} : { trigger: event.trigger }),
            ...(event.context_tokens_before === undefined
              ? {}
              : { contextTokensBefore: event.context_tokens_before }),
          });
          break;
        }
        case "compaction_summary": {
          if (openCompaction === undefined) break;
          const event = body as CompactionSummaryEvent;
          const compaction = compactions[openCompaction] as DerivedCompaction;
          compactions[openCompaction] = {
            ...compaction,
            summaryEventId: row.eventId,
            endedAtUs: row.timestampUs,
            ...(event.model === undefined ? {} : { model: event.model }),
            ...(event.usage === undefined ? {} : { usage: event.usage }),
          };
          openCompaction = undefined;
          if (compaction.trigger === "manual") ending = "manual_compaction";
          break;
        }
      }
    }
    previous = row;
    last = row;
  }

  if (!start || !last) return undefined;
  return {
    id: turnId,
    status: statusOf(ending),
    startedAtUs: start.timestampUs,
    endedAtUs: last.timestampUs,
    ingestId: start.ingestId,
    llmCalls,
    toolCalls,
    compactions,
    lastIngestId,
  };
}

function statusOf(ending: Ending): TurnStatus {
  switch (ending) {
    case "final":
    case "manual_compaction":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "stopped_by_error":
      return "errored";
    case "open":
      return "in_progress";
  }
}

function toolUseBlocks(event: AssistantMessageEvent): ToolUseBlock[] {
  return event.content.filter((block): block is ToolUseBlock => block.type === "tool_use");
}

function toToolCall(open: OpenToolCall): DerivedToolCall {
  return {
    llmCallId: open.llmCallId,
    ordinal: open.ordinal,
    toolUseId: open.block.tool_use_id,
    name: open.block.name,
    startedAtUs: open.startedAtUs,
  };
}

function toLlmCall(
  row: TurnEventRow,
  event: AssistantMessageEvent,
  previous: TurnEventRow | undefined,
): DerivedLlmCall {
  const recorded = event.started_at === undefined ? undefined : parseTimestampUs(event.started_at);
  return {
    id: row.eventId,
    position: row.position,
    failed: event.error !== undefined,
    startedAtUs: recorded ?? previous?.timestampUs ?? row.timestampUs,
    startedAtEstimated: recorded === undefined,
    endedAtUs: row.timestampUs,
    ...(event.model === undefined ? {} : { model: event.model }),
    ...(event.stop_reason === undefined ? {} : { stopReason: event.stop_reason }),
    ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
    ...(event.usage === undefined ? {} : { usage: event.usage }),
  };
}
