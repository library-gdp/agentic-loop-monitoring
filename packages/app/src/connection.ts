import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Connection {
  readonly url: string;
  readonly token: string;
}

export function connectionPath(stateDirectory: string): string {
  return join(stateDirectory, "visualization.json");
}

/** 주소와 접근 토큰을 권한 0600 파일에 씁니다. 다른 계정이 읽을 수 없어야 합니다. */
export function writeConnection(stateDirectory: string, connection: Connection): void {
  const path = connectionPath(stateDirectory);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(connection), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** 브라우저로 처음 접속할 URL입니다. */
export function readAccessUrl(stateDirectory: string): string {
  const { url, token } = JSON.parse(
    readFileSync(connectionPath(stateDirectory), "utf8"),
  ) as Connection;
  return `${url}?token=${encodeURIComponent(token)}`;
}
