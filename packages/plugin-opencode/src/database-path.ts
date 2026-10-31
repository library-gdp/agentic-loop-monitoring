import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** 기본 위치입니다. OpenCode의 채널이나 환경 변수로 바꾼 DB는 설정의 database로 지정합니다. */
export function resolveDatabasePath(
  configured: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const directory = join(dataHome, "opencode");
  const path = configured ?? env.OPENCODE_DB;
  if (!path) return join(directory, "opencode.db");
  return isAbsolute(path) ? path : join(directory, path);
}
