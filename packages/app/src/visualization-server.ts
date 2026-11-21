/**
 * Visualization의 웹 서버입니다(docs/002.implementation/011.VISUALIZATION.md의 구성과 접속).
 * Main Server 프로세스의 Bun.serve 하나가 routes로 SPA를, fetch로 Hono 라우트를 함께 제공합니다.
 * 127.0.0.1에만 바인딩하고, 시작할 때 만든 접근 토큰과 주소를 상태 디렉터리의 권한 0600 파일에 씁니다.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger, QueryApi } from "@agentoscope/core";
import { createVisualization, LOGIN_PATH } from "@agentoscope/visualization";

/** 상태 디렉터리 안의 접속 정보 파일 이름입니다. */
export const CONNECTION_FILE = "visualization.json";
/** 바인딩하는 주소입니다. */
const HOSTNAME = "127.0.0.1";
/** 접근 토큰의 바이트 수입니다. base64url로 43자입니다. */
const TOKEN_BYTES = 32;

/** 접속 정보 파일의 내용입니다. */
export interface VisualizationConnection {
    /** Visualization의 주소입니다(예: http://127.0.0.1:43123/). */
    readonly url: string;
    readonly token: string;
    /** 서버를 띄운 프로세스입니다. */
    readonly pid: number;
}

export interface VisualizationServerOptions {
    readonly query: QueryApi;
    /** 0이면 운영체제가 빈 포트를 고릅니다. */
    readonly port: number;
    /** 접속 정보 파일을 두는 디렉터리입니다. */
    readonly stateDirectory: string;
    readonly logger: Logger;
}

export interface VisualizationServer {
    readonly url: string;
    /** 서버를 멈추고 접속 정보 파일을 지웁니다. */
    stop(): Promise<void>;
}

export function startVisualizationServer(options: VisualizationServerOptions): VisualizationServer {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    let host = "";
    const visualization = createVisualization({
        query: options.query,
        token,
        host: () => host,
        logger: options.logger,
    });
    const server = Bun.serve({
        hostname: HOSTNAME,
        port: options.port,
        development: false,
        routes: visualization.routes,
        fetch: visualization.fetch,
    });
    host = `${HOSTNAME}:${server.port}`;
    const url = `http://${host}/`;

    const path = join(options.stateDirectory, CONNECTION_FILE);
    const connection: VisualizationConnection = { url, token, pid: process.pid };
    try {
        writePrivateFile(path, `${JSON.stringify(connection)}\n`);
    } catch (error) {
        void server.stop(true);
        throw error;
    }

    let stopped = false;
    return {
        url,
        async stop() {
            if (stopped) return;
            stopped = true;
            // 다른 프로세스가 그사이 파일을 바꿨으면 지우지 않습니다.
            if (readConnection(options.stateDirectory)?.token === token)
                rmSync(path, { force: true });
            await server.stop(true);
        },
    };
}

/** 접속 정보 파일을 읽습니다. 없거나 형식이 맞지 않으면 undefined입니다. */
export function readConnection(stateDirectory: string): VisualizationConnection | undefined {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(join(stateDirectory, CONNECTION_FILE), "utf8"));
    } catch {
        return undefined;
    }
    if (typeof value !== "object" || value === null) return undefined;
    const { url, token, pid } = value as Record<string, unknown>;
    if (typeof url !== "string" || typeof token !== "string" || typeof pid !== "number") {
        return undefined;
    }
    return { url, token, pid };
}

/** 브라우저로 열 접속 URL입니다. 처음 접속하면 토큰을 쿠키로 바꾸고 토큰이 없는 URL로 보냅니다. */
export function loginUrl(connection: VisualizationConnection): string {
    return new URL(
        `${LOGIN_PATH}?token=${encodeURIComponent(connection.token)}`,
        connection.url,
    ).toString();
}

/** 권한 0600 파일을 씁니다. 다 쓴 뒤에 이름을 바꾸므로 읽는 쪽이 반쯤 쓴 파일을 보지 않습니다. */
function writePrivateFile(path: string, text: string): void {
    const directory = join(path, "..");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporary = `${path}.${process.pid}.tmp`;
    try {
        writeFileSync(temporary, text, { mode: 0o600 });
        chmodSync(temporary, 0o600);
        renameSync(temporary, path);
    } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
    }
}
