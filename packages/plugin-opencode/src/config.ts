/**
 * agentoscope가 OpenCode Plugin에 쓰는 설정입니다(docs/002.implementation/006.plugin/003.opencode/002.CONFIGURATION.md).
 * OpenCode가 쓰는 환경 변수와 설정 파일은 읽지 않습니다.
 */

import { isAbsolute, join } from "node:path";

export const DB_ENV = "AGENTOSCOPE_OPENCODE_DB";

export type DbPath = { readonly path: string } | { readonly error: string };

/** 수집할 OpenCode DB 파일의 경로입니다. 환경 변수가 없거나 비어 있으면 기본 위치를 씁니다. */
export function resolveDbPath(
    env: Readonly<Record<string, string | undefined>>,
    home: string,
): DbPath {
    const value = env[DB_ENV];
    if (value === undefined || value === "") {
        return { path: join(home, ".local", "share", "opencode", "opencode.db") };
    }
    if (!isAbsolute(value)) return { error: `${DB_ENV} must be an absolute path` };
    return { path: value };
}
