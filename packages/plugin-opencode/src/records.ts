/**
 * OpenCode 1.19.x `event` 행의 `data` 가운데 Plugin이 쓰는 부분의 형식입니다.
 * docs/003.reference/003.OPENCODE_SESSION_LOG.md를 따릅니다. 모르는 필드는 무시합니다.
 */

import * as v from "valibot";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
/** OpenCode가 기록한 시각(Unix epoch 밀리초)입니다. */
const epochMs = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const jsonObject = v.custom<Readonly<Record<string, unknown>>>(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
    "must be a JSON object",
);

export const tokensSchema = v.looseObject({
    input: v.optional(count),
    output: v.optional(count),
    reasoning: v.optional(count),
    cache: v.optional(
        v.looseObject({
            read: v.optional(count),
            write: v.optional(count),
        }),
    ),
});

const userInfo = v.looseObject({
    id: nonEmptyString,
    role: v.literal("user"),
});

const assistantInfo = v.looseObject({
    id: nonEmptyString,
    role: v.literal("assistant"),
    parentID: nonEmptyString,
    modelID: v.optional(v.string()),
    summary: v.optional(v.unknown()),
    time: v.looseObject({
        created: v.optional(epochMs),
        completed: v.optional(epochMs),
    }),
    error: v.optional(
        v.looseObject({
            name: v.string(),
            data: v.optional(
                v.looseObject({
                    message: v.optional(v.unknown()),
                    statusCode: v.optional(v.unknown()),
                }),
            ),
        }),
    ),
});

export type AssistantInfo = v.InferOutput<typeof assistantInfo>;

/** `message.updated.1`의 data입니다. user와 assistant가 아닌 message는 info를 검사하지 않습니다. */
export const messageUpdatedSchema = v.looseObject({
    info: v.variant("role", [
        userInfo,
        assistantInfo,
        v.looseObject({
            id: nonEmptyString,
            role: v.pipe(
                v.string(),
                v.check((role) => role !== "user" && role !== "assistant"),
            ),
        }),
    ]),
});

/** `message.part.updated.1`의 data입니다. part는 공통 필드만 검사하고, 종류별 필드는 partSchemas로 검사합니다. */
export const partUpdatedSchema = v.looseObject({
    part: v.looseObject({
        id: nonEmptyString,
        messageID: nonEmptyString,
        type: v.string(),
    }),
    time: v.optional(epochMs),
});

const textPart = v.looseObject({
    type: v.literal("text"),
    text: v.string(),
    synthetic: v.optional(v.boolean()),
    ignored: v.optional(v.boolean()),
});

const reasoningPart = v.looseObject({
    type: v.literal("reasoning"),
    text: v.string(),
});

const toolPart = v.looseObject({
    type: v.literal("tool"),
    callID: nonEmptyString,
    tool: nonEmptyString,
    state: v.looseObject({
        status: v.string(),
        input: v.optional(jsonObject),
        output: v.optional(v.string()),
        error: v.optional(v.string()),
        metadata: v.optional(jsonObject),
        time: v.optional(
            v.looseObject({
                start: v.optional(epochMs),
                end: v.optional(epochMs),
            }),
        ),
    }),
});

const stepFinishPart = v.looseObject({
    type: v.literal("step-finish"),
    reason: v.optional(v.string()),
    tokens: v.optional(tokensSchema),
});

const compactionPart = v.looseObject({
    type: v.literal("compaction"),
    auto: v.optional(v.boolean()),
});

/** Plugin이 쓰는 part 종류의 형식입니다. 여기 없는 종류(file, agent, patch 등)는 쓰지 않습니다. */
export const partSchemas = {
    text: textPart,
    reasoning: reasoningPart,
    tool: toolPart,
    "step-start": v.looseObject({ type: v.literal("step-start") }),
    "step-finish": stepFinishPart,
    compaction: compactionPart,
    subtask: v.looseObject({ type: v.literal("subtask") }),
} as const;

export type TextPart = v.InferOutput<typeof textPart>;
export type ReasoningPart = v.InferOutput<typeof reasoningPart>;
export type ToolPart = v.InferOutput<typeof toolPart>;
export type StepFinishPart = v.InferOutput<typeof stepFinishPart>;
export type CompactionPart = v.InferOutput<typeof compactionPart>;
export type Tokens = v.InferOutput<typeof tokensSchema>;

export type KnownPartType = keyof typeof partSchemas;

export function isKnownPartType(type: string): type is KnownPartType {
    return Object.hasOwn(partSchemas, type);
}
