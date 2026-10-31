import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 상태 디렉터리의 잠금 파일을 잡습니다. 다른 Daemon이 실행 중이면 false입니다. */
export function acquireLock(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const pid = Number(readFileSync(path, "utf8"));
    if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) return false;
    rmSync(path, { force: true });
  }
  return false;
}

export function releaseLock(path: string): void {
  rmSync(path, { force: true });
}
