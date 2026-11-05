import type { JsonObject } from "@alm/plugin-api";
import * as v from "valibot";

/** OpenCode 1.19.x `event` 행의 data입니다. 쓰는 필드만 검사하고 나머지는 무시합니다. */

const TokensSchema = v.looseObject({
  input: v.number(),
  output: v.number(),
  reasoning: v.number(),
  cache: v.looseObject({ read: v.number(), write: v.number() }),
});

const ErrorSchema = v.looseObject({
  name: v.string(),
  data: v.optional(
    v.looseObject({
      message: v.optional(v.unknown()),
      statusCode: v.optional(v.unknown()),
    }),
  ),
});

const UserInfoSchema = v.looseObject({
  id: v.string(),
  role: v.literal("user"),
  time: v.looseObject({ created: v.number() }),
});

const AssistantInfoSchema = v.looseObject({
  id: v.string(),
  role: v.literal("assistant"),
  parentID: v.string(),
  modelID: v.string(),
  summary: v.optional(v.boolean()),
  finish: v.optional(v.string()),
  error: v.optional(ErrorSchema),
  tokens: v.optional(TokensSchema),
  time: v.looseObject({ created: v.number(), completed: v.optional(v.number()) }),
});

export const MessageUpdatedSchema = v.looseObject({
  info: v.variant("role", [UserInfoSchema, AssistantInfoSchema]),
});

export const PartUpdatedSchema = v.looseObject({
  part: v.looseObject({
    id: v.string(),
    messageID: v.string(),
    type: v.string(),
  }),
});

export const MessageRemovedSchema = v.looseObject({ messageID: v.string() });

export const PartRemovedSchema = v.looseObject({ messageID: v.string(), partID: v.string() });

const ToolStateSchema = v.looseObject({
  status: v.string(),
  input: v.optional(v.record(v.string(), v.unknown())),
  output: v.optional(v.string()),
  error: v.optional(v.string()),
  metadata: v.optional(v.record(v.string(), v.unknown())),
  time: v.optional(v.looseObject({ start: v.optional(v.number()), end: v.optional(v.number()) })),
});

export const TextPartSchema = v.looseObject({
  type: v.picklist(["text", "reasoning"]),
  text: v.string(),
  synthetic: v.optional(v.boolean()),
  ignored: v.optional(v.boolean()),
});

export const ToolPartSchema = v.looseObject({
  type: v.literal("tool"),
  callID: v.string(),
  tool: v.string(),
  state: ToolStateSchema,
});

export const CompactionPartSchema = v.looseObject({
  type: v.literal("compaction"),
  auto: v.boolean(),
});

export const SubtaskPartSchema = v.looseObject({
  type: v.literal("subtask"),
  prompt: v.string(),
});

export const FilePartSchema = v.looseObject({
  type: v.literal("file"),
  mime: v.string(),
  filename: v.optional(v.string()),
});

export const StepFinishPartSchema = v.looseObject({
  type: v.literal("step-finish"),
  tokens: TokensSchema,
});

export type UserInfo = v.InferOutput<typeof UserInfoSchema>;
export type AssistantInfo = v.InferOutput<typeof AssistantInfoSchema>;
export type OpenCodeError = v.InferOutput<typeof ErrorSchema>;
export type Tokens = v.InferOutput<typeof TokensSchema>;
export type ToolPart = v.InferOutput<typeof ToolPartSchema>;

/** 모르는 종류를 포함한 part입니다. 쓸 때 위의 Schema로 다시 확인합니다. */
export interface RawPart {
  readonly id: string;
  readonly messageID: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

export function toJsonObject(value: Record<string, unknown> | undefined): JsonObject {
  return (value ?? {}) as JsonObject;
}
