import type { Logger } from "@agentoscope/core";

/** 로그 한 줄을 JSON으로 표준 오류에 씁니다. 로그를 쓰다 난 오류로 호출한 쪽을 멈추지 않습니다. */
export function createJsonLinesLogger(
    write: (line: string) => void = (line) => process.stderr.write(line),
): Logger {
    const log =
        (level: "info" | "warn" | "error") =>
        (message: string, details?: Readonly<Record<string, unknown>>) => {
            const entry = {
                time: new Date().toISOString(),
                level,
                message,
                ...(details && { details }),
            };
            let line: string;
            try {
                line = JSON.stringify(entry);
            } catch {
                line = JSON.stringify({ time: entry.time, level, message });
            }
            try {
                write(`${line}\n`);
            } catch {
                // 로그를 쓸 수 없어도 계속합니다.
            }
        };
    return { info: log("info"), warn: log("warn"), error: log("error") };
}
