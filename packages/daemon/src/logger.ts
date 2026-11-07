import { createWriteStream, type WriteStream } from "node:fs";

export type LogLevel = "info" | "warn" | "error";

export interface DaemonLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
  /** details에 항상 fields를 더하는 logger를 만듭니다. */
  with(fields: Record<string, unknown>): DaemonLogger;
}

/** 로그 파일에 JSON 한 줄씩 기록합니다. 에이전트에는 아무것도 출력하지 않습니다. */
export class FileLogger implements DaemonLogger {
  readonly #stream: WriteStream;

  constructor(path: string) {
    this.#stream = createWriteStream(path, { flags: "a", mode: 0o600 });
    this.#stream.on("error", () => {});
  }

  info(message: string, details?: Record<string, unknown>): void {
    this.#write("info", message, details);
  }

  warn(message: string, details?: Record<string, unknown>): void {
    this.#write("warn", message, details);
  }

  error(message: string, details?: Record<string, unknown>): void {
    this.#write("error", message, details);
  }

  with(fields: Record<string, unknown>): DaemonLogger {
    return scoped(this, fields);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.#stream.end(resolve));
  }

  #write(level: LogLevel, message: string, details?: Record<string, unknown>): void {
    const record = { time: new Date().toISOString(), level, message, ...details };
    this.#stream.write(`${JSON.stringify(record)}\n`);
  }
}

function scoped(base: DaemonLogger, fields: Record<string, unknown>): DaemonLogger {
  return {
    info: (message, details) => base.info(message, { ...fields, ...details }),
    warn: (message, details) => base.warn(message, { ...fields, ...details }),
    error: (message, details) => base.error(message, { ...fields, ...details }),
    with: (more) => scoped(base, { ...fields, ...more }),
  };
}
