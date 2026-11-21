/** Daemon이 로그를 남기는 창구입니다. 어디에 쓰는지는 실행 구성이 정합니다. */
export interface Logger {
    info(message: string, details?: Readonly<Record<string, unknown>>): void;
    warn(message: string, details?: Readonly<Record<string, unknown>>): void;
    error(message: string, details?: Readonly<Record<string, unknown>>): void;
}

/** 로그마다 details에 같은 값을 더합니다. Plugin의 로그에 에이전트 id를 붙일 때 씁니다. */
export function withDetails(logger: Logger, extra: Readonly<Record<string, unknown>>): Logger {
    const wrap =
        (level: keyof Logger) =>
        (message: string, details?: Readonly<Record<string, unknown>>): void => {
            try {
                logger[level](message, { ...extra, ...details });
            } catch {
                // 로그를 남기지 못해도 부른 쪽을 멈추지 않습니다.
            }
        };
    return { info: wrap("info"), warn: wrap("warn"), error: wrap("error") };
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
