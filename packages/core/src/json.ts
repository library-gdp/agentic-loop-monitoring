/** JSON에서 읽은 값이 객체(배열 아님)인지 확인합니다. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON 텍스트를 객체로 읽습니다. 해석할 수 없거나 객체가 아니면 undefined입니다. */
export function parseRecord(text: string): Readonly<Record<string, unknown>> | undefined {
    try {
        const value: unknown = JSON.parse(text);
        return isRecord(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

/** 0 이상의 안전한 정수이면 그 값을, 아니면 undefined를 돌려줍니다. */
export function nonNegativeInteger(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}

/** readonly를 뗀 타입입니다. 선택 필드를 값이 있을 때만 채울 때 씁니다. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };
