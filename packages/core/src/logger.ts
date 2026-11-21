/** Main Server의 모듈이 로그를 남기는 창구입니다. 어디에 어떻게 쓰는지는 실행 구성이 정합니다. */
export interface Logger {
    info(message: string, details?: Readonly<Record<string, unknown>>): void;
    warn(message: string, details?: Readonly<Record<string, unknown>>): void;
    error(message: string, details?: Readonly<Record<string, unknown>>): void;
}
