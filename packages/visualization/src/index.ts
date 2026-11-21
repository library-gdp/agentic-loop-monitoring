/**
 * Main Server의 Visualization입니다(docs/002.implementation/011.VISUALIZATION.md).
 * 브라우저에서 실행되는 SPA와, SPA에 데이터를 주는 Hono 라우트로 이루어집니다. 데이터는 Core의 Query API로만 읽습니다.
 */

import type { Logger, QueryApi } from "@agentoscope/core";
import type { HTMLBundle } from "bun";
import { createRoutes } from "./server";
import page from "./web/index.html";

export { DEFAULT_SESSION_PAGE_SIZE, LOGIN_PATH, TOKEN_COOKIE } from "./server";

export interface VisualizationOptions {
    readonly query: QueryApi;
    /** 접근 토큰입니다. */
    readonly token: string;
    /** 바인딩한 주소와 포트입니다(예: 127.0.0.1:43123). Host 헤더가 이와 다른 요청은 거절합니다. */
    readonly host: () => string;
    readonly logger: Logger;
}

export interface Visualization {
    /** Bun.serve의 routes에 붙입니다. SPA의 페이지입니다. */
    readonly routes: { readonly "/": HTMLBundle };
    /** Bun.serve의 fetch에 붙입니다. 접속과 데이터 라우트입니다. */
    readonly fetch: (request: Request) => Response | Promise<Response>;
}

export function createVisualization(options: VisualizationOptions): Visualization {
    const app = createRoutes(options);
    return { routes: { "/": page }, fetch: (request) => app.fetch(request) };
}
