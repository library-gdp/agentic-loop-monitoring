/**
 * 같은 상태 디렉터리를 쓰는 Daemon이 하나만 실행되게 합니다
 * (docs/002.implementation/007.CLIENT_ADAPTER_DAEMON.md의 "실행").
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export const LOCK_FILE = "daemon.lock";

/** 같은 상태 디렉터리를 쓰는 다른 Daemon이 이미 실행 중일 때 던집니다. */
export class DaemonAlreadyRunningError extends Error {
    override readonly name = "DaemonAlreadyRunningError";
}

export interface DaemonLock {
    release(): void;
}

function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // 다른 사용자의 프로세스이면 EPERM입니다. 그 프로세스도 살아 있습니다.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/**
 * 상태 디렉터리에 잠금 파일을 만들고 이 프로세스의 PID를 씁니다. 잠금 파일이 있어도 그 PID의 프로세스가 없으면
 * 비정상 종료로 남은 것으로 보고 다시 만듭니다.
 */
export function acquireLock(stateDirectory: string): DaemonLock {
    const path = join(stateDirectory, LOCK_FILE);
    for (let attempt = 0; attempt < 2; attempt++) {
        let fd: number;
        try {
            fd = openSync(path, "wx", 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            let pid = Number.NaN;
            try {
                pid = Number.parseInt(readFileSync(path, "utf8"), 10);
            } catch {
                // 다른 Daemon이 막 만들거나 지우는 중일 수 있습니다. 아래에서 다시 시도합니다.
            }
            if (Number.isSafeInteger(pid) && pid > 0 && isRunning(pid)) {
                throw new DaemonAlreadyRunningError(
                    `another daemon (pid ${pid}) is using ${stateDirectory}`,
                );
            }
            try {
                unlinkSync(path);
            } catch {
                // 이미 지워졌으면 그대로 다시 만듭니다.
            }
            continue;
        }
        try {
            writeSync(fd, `${process.pid}\n`);
        } finally {
            closeSync(fd);
        }
        let released = false;
        return {
            release() {
                if (released) return;
                released = true;
                try {
                    if (Number.parseInt(readFileSync(path, "utf8"), 10) === process.pid) {
                        unlinkSync(path);
                    }
                } catch {
                    // 잠금 파일이 없어졌으면 할 일이 없습니다.
                }
            },
        };
    }
    throw new DaemonAlreadyRunningError(`cannot lock ${stateDirectory}`);
}
