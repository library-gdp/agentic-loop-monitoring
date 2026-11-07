import type {
  AssistantMessageEvent,
  ContentBlock,
  LlmCallError,
  SessionLogEvent,
  StopReason,
  TokenUsage,
  ToolResultEvent,
} from "@alm/plugin-api";
import * as v from "valibot";
import {
  type AssistantInfo,
  CompactionPartSchema,
  FilePartSchema,
  type OpenCodeError,
  type RawPart,
  StepFinishPartSchema,
  SubtaskPartSchema,
  TextPartSchema,
  type Tokens,
  type ToolPart,
  ToolPartSchema,
  toJsonObject,
} from "./records";

const ABORTED = "MessageAbortedError";
const OUTPUT_LENGTH = "MessageOutputLengthError";

export function toTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

const STOP_REASONS: Readonly<Record<string, StopReason>> = {
  stop: "end_turn",
  "tool-calls": "tool_use",
  length: "max_tokens",
  "content-filter": "refusal",
};

export function toToolParts(parts: Iterable<RawPart>): ToolPart[] {
  const tools: ToolPart[] = [];
  for (const part of parts) {
    const tool = v.safeParse(ToolPartSchema, part);
    if (tool.success) tools.push(tool.output);
  }
  return tools;
}

/** 도구 실행이 끝났는지입니다. 끝난 part만 tool_result를 만듭니다. */
export function isToolFinished(tool: ToolPart): boolean {
  return tool.state.status === "completed" || tool.state.status === "error";
}

/** OpenCode는 step-start를 LLM 응답에서만 기록하므로, 없는데 도구가 있으면 사용자 shell이나 subtask입니다. */
export function isLlmCall(parts: Iterable<RawPart>): boolean {
  let hasTool = false;
  for (const part of parts) {
    if (part.type === "step-start") return true;
    if (part.type === "tool") hasTool = true;
  }
  return !hasTool;
}

export function isAborted(info: AssistantInfo): boolean {
  return info.error?.name === ABORTED;
}

/** 응답이 Turn을 끝내는지입니다. OpenCode의 Loop가 멈추는 조건과 같습니다. */
export function endsTurn(info: AssistantInfo, parts: Iterable<RawPart>): boolean {
  if (info.error) return true;
  if (!info.finish || info.finish === "tool-calls" || info.finish === "unknown") return false;
  return toToolParts(parts).length === 0;
}

function toUsage(tokens: Tokens): TokenUsage {
  return {
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    reasoning_tokens: tokens.reasoning,
    cache_read_tokens: tokens.cache.read,
    cache_write_tokens: tokens.cache.write,
  };
}

/** step-finish의 tokens를 더합니다. 응답을 끝까지 받지 못해 step-finish가 없으면 기록하지 않은 것입니다. */
function usageOf(parts: Iterable<RawPart>): TokenUsage | undefined {
  let usage: Required<TokenUsage> | undefined;
  for (const part of parts) {
    const step = v.safeParse(StepFinishPartSchema, part);
    if (!step.success) continue;
    const next = toUsage(step.output.tokens) as Required<TokenUsage>;
    usage = usage
      ? {
          input_tokens: usage.input_tokens + next.input_tokens,
          output_tokens: usage.output_tokens + next.output_tokens,
          reasoning_tokens: usage.reasoning_tokens + next.reasoning_tokens,
          cache_read_tokens: usage.cache_read_tokens + next.cache_read_tokens,
          cache_write_tokens: usage.cache_write_tokens + next.cache_write_tokens,
        }
      : next;
  }
  return usage;
}

function toContent(parts: Iterable<RawPart>): ContentBlock[] {
  const content: ContentBlock[] = [];
  for (const part of parts) {
    const text = v.safeParse(TextPartSchema, part);
    if (text.success) {
      if (text.output.text === "" || text.output.ignored) continue;
      content.push({ type: text.output.type, text: text.output.text });
      continue;
    }
    const tool = v.safeParse(ToolPartSchema, part);
    if (tool.success && tool.output.state.status !== "pending") {
      content.push({
        type: "tool_use",
        tool_use_id: tool.output.callID,
        name: tool.output.tool,
        input: toJsonObject(tool.output.state.input),
      });
    }
  }
  return content;
}

function toLlmCallError(error: OpenCodeError): LlmCallError {
  const { message, statusCode } = error.data ?? {};
  return {
    message: typeof message === "string" ? message : error.name,
    code: error.name,
    // OpenCode는 다시 보낼 오류를 message에 남기지 않고 같은 message 안에서 재시도합니다.
    will_retry: false,
    ...(typeof statusCode === "number" ? { status_code: statusCode } : {}),
  };
}

/**
 * 모델의 응답이 기록된 시각입니다. OpenCode는 도구를 응답 스트림 안에서 실행하므로 message가 끝난 시각에는
 * 도구 실행 시간이 들어갑니다. Tool Call의 시작 시각이 끝난 시각을 넘지 않도록 첫 도구가 시작된 시각을 씁니다.
 */
function responseTime(info: AssistantInfo, tools: readonly ToolPart[]): number {
  const started = tools.flatMap((tool) => tool.state.time?.start ?? []);
  if (started.length > 0) return Math.min(...started);
  return info.time.completed ?? info.time.created;
}

/** LLM Call 하나를 assistant_message와 tool_result로 바꿉니다. 이 Session Log Event들은 한 레코드에서 나옵니다. */
export function toLlmCallEvents(info: AssistantInfo, parts: readonly RawPart[]): SessionLogEvent[] {
  const aborted = isAborted(info);
  const content = toContent(parts);
  const tools = toToolParts(parts);
  const events: SessionLogEvent[] = [];
  // 끝나지 않은 채 남은 message의 빈 응답은 최종 응답처럼 보이므로 만들지 않습니다.
  const unfinished = info.time.completed === undefined;

  if ((!aborted && !unfinished) || content.length > 0) {
    const truncated = info.error?.name === OUTPUT_LENGTH;
    const failed = info.error !== undefined && !aborted && !truncated;
    const stopReason: StopReason | undefined = truncated
      ? "max_tokens"
      : info.finish === undefined
        ? undefined
        : (STOP_REASONS[info.finish] ?? "other");
    const usage = usageOf(parts);
    const event: AssistantMessageEvent = {
      event_id: info.id,
      type: "assistant_message",
      timestamp: toTimestamp(responseTime(info, tools)),
      started_at: toTimestamp(info.time.created),
      model: info.modelID,
      content,
      ...(failed && info.error ? { error: toLlmCallError(info.error) } : {}),
      ...(!failed && !aborted && stopReason ? { stop_reason: stopReason } : {}),
      ...(usage ? { usage } : {}),
    };
    events.push(event);
  }

  for (const tool of tools) {
    if (isToolFinished(tool)) events.push(toToolResult(tool, info));
  }
  if (aborted) {
    events.push({
      event_id: `${info.id}:interrupted`,
      type: "turn_interrupted",
      timestamp: toTimestamp(info.time.completed ?? info.time.created),
    });
  }
  return events;
}

function toToolResult(tool: ToolPart, info: AssistantInfo): ToolResultEvent {
  const { state } = tool;
  const failed = state.status === "error";
  const subagentId = state.metadata?.sessionId;
  return {
    event_id: `${info.id}:${tool.callID}`,
    type: "tool_result",
    timestamp: toTimestamp(state.time?.end ?? info.time.completed ?? info.time.created),
    tool_use_id: tool.callID,
    output: (failed ? state.error : state.output) ?? "",
    is_error: failed,
    ...(tool.tool === "task" && typeof subagentId === "string" ? { subagent_id: subagentId } : {}),
  };
}

/** compaction 요약을 만든 message를 Session Log Event로 바꿉니다. */
export function toCompactionEvents(
  info: AssistantInfo,
  parts: readonly RawPart[],
  trigger: "auto" | "manual" | undefined,
): SessionLogEvent[] {
  const events: SessionLogEvent[] = [
    {
      event_id: `${info.id}:compaction`,
      type: "compaction",
      timestamp: toTimestamp(info.time.created),
      ...(trigger ? { trigger } : {}),
    },
  ];
  const completed = toTimestamp(info.time.completed ?? info.time.created);
  if (isAborted(info)) {
    events.push({
      event_id: `${info.id}:interrupted`,
      type: "turn_interrupted",
      timestamp: completed,
    });
  } else if (info.error) {
    events.push({
      event_id: info.id,
      type: "assistant_message",
      timestamp: completed,
      started_at: toTimestamp(info.time.created),
      model: info.modelID,
      content: [],
      error: toLlmCallError(info.error),
    });
  } else {
    const usage = usageOf(parts);
    events.push({
      event_id: `${info.id}:summary`,
      type: "compaction_summary",
      timestamp: completed,
      text: partsToText(parts, false),
      model: info.modelID,
      ...(usage ? { usage } : {}),
    });
  }
  return events;
}

/** 사용자 shell이나 subtask처럼 LLM Call 없이 실행한 도구를 뒤 LLM Call의 input으로 나타냅니다. */
export function toToolContextText(parts: readonly RawPart[]): string {
  return toToolParts(parts)
    .map((tool) => {
      const output = tool.state.status === "error" ? tool.state.error : tool.state.output;
      return `[${tool.tool}] ${JSON.stringify(tool.state.input ?? {})}\n${output ?? ""}`;
    })
    .join("\n\n");
}

/** user message의 text입니다. 모델에 들어가지 않는 ignored part는 뺍니다. */
export function userMessageText(parts: readonly RawPart[]): string {
  return partsToText(parts, true);
}

function partsToText(parts: readonly RawPart[], user: boolean): string {
  const lines: string[] = [];
  for (const part of parts) {
    const text = v.safeParse(TextPartSchema, part);
    if (text.success) {
      if (text.output.type !== "text" || text.output.ignored || text.output.text === "") continue;
      lines.push(text.output.text);
      continue;
    }
    if (!user) continue;
    const subtask = v.safeParse(SubtaskPartSchema, part);
    if (subtask.success) {
      lines.push(subtask.output.prompt);
      continue;
    }
    const file = v.safeParse(FilePartSchema, part);
    if (file.success && file.output.mime !== "text/plain") {
      lines.push(`[Attached ${file.output.mime}: ${file.output.filename ?? "file"}]`);
    }
  }
  return lines.join("\n\n");
}

/** compaction part가 있으면 그 trigger입니다. */
export function compactionTrigger(parts: Iterable<RawPart>): "auto" | "manual" | undefined {
  for (const part of parts) {
    const compaction = v.safeParse(CompactionPartSchema, part);
    if (compaction.success) return compaction.output.auto ? "auto" : "manual";
  }
  return undefined;
}

/** 사용자가 입력한 프롬프트인지입니다. 모든 part가 synthetic이면 OpenCode가 만든 메시지입니다. */
export function isUserPrompt(parts: readonly RawPart[]): boolean {
  return parts.some((part) => part.synthetic !== true);
}
