/**
 * OpenCode v1(1.19.x) Plugin입니다. Trigger는 docs/002.implementation/006.plugin/003.opencode/001.OVERVIEW.md의
 * "Trigger"를 따릅니다: 시작할 때 한 번, DB 디렉터리의 `-wal` 변경 알림마다, 30초마다 수집합니다.
 */

import { type FSWatcher, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Plugin, PluginContext } from "@agentoscope/plugin-api";
import packageJson from "../package.json" with { type: "json" };
import { type Collector, createCollector } from "./collector";
import { resolveDbPath } from "./config";
import { loadState, STATE_FILE } from "./state";

export const AGENT_ID = "opencode";
export const RESCAN_INTERVAL_MS = 30_000;

export interface OpenCodePluginOptions {
    /** 환경 변수입니다. 기본값은 process.env입니다. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** 홈 디렉터리입니다. 기본값은 os.homedir()입니다. */
    readonly home?: string;
    /** 주기적으로 다시 수집하는 간격(밀리초)입니다. */
    readonly rescanIntervalMs?: number;
    readonly batchSize?: number;
}

export function createOpenCodePlugin(options: OpenCodePluginOptions = {}): Plugin {
    let stopped = false;
    let collector: Collector | undefined;
    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let running: Promise<void> | undefined;
    let again = false;

    return {
        agent: AGENT_ID,
        version: packageJson.version,

        async start(context: PluginContext) {
            stopped = false;
            const { logger } = context;
            const db = resolveDbPath(options.env ?? process.env, options.home ?? homedir());
            if ("error" in db) {
                // 시작은 끝내되 수집하지 않습니다. Daemon과 다른 Plugin은 그대로 동작합니다.
                logger.error("not collecting OpenCode sessions", { reason: db.error });
                return;
            }
            const statePath = join(context.stateDirectory, STATE_FILE);
            const loaded = await loadState(statePath, db.path);
            if (loaded.problem !== undefined) {
                logger.warn("collecting OpenCode sessions from the beginning", {
                    reason: loaded.problem,
                });
            }
            const active = createCollector({
                dbPath: db.path,
                statePath,
                state: loaded.state,
                submit: (unit) => {
                    if (!stopped) context.submit(unit);
                },
                logger,
                stopping: () => stopped,
                ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
            });
            collector = active;

            /** 수집을 겹쳐 실행하지 않습니다. 수집 중에 알림이 오면 끝난 뒤 한 번 더 수집합니다. */
            const run = (): void => {
                if (stopped) return;
                if (running !== undefined) {
                    again = true;
                    return;
                }
                running = (async () => {
                    try {
                        do {
                            again = false;
                            await active.collect();
                        } while (again && !stopped);
                    } catch (error) {
                        logger.error("cannot collect OpenCode sessions", {
                            message: error instanceof Error ? error.message : String(error),
                        });
                    } finally {
                        running = undefined;
                    }
                })();
            };

            const walFile = `${basename(db.path)}-wal`;
            const startWatching = (): void => {
                if (watcher !== undefined || stopped) return;
                try {
                    const current = watch(dirname(db.path), (_event, filename) => {
                        // -shm은 읽기만 해도 바뀌므로 거릅니다. 파일 이름을 알 수 없으면 수집합니다.
                        if (filename === null || filename === walFile) run();
                    });
                    current.on("error", () => {
                        current.close();
                        if (watcher === current) watcher = undefined;
                    });
                    watcher = current;
                } catch {
                    // 디렉터리가 아직 없습니다. 주기적인 확인에서 다시 겁니다.
                }
            };

            startWatching();
            timer = setInterval(() => {
                startWatching();
                run();
            }, options.rescanIntervalMs ?? RESCAN_INTERVAL_MS);
            run();
            logger.info("collecting OpenCode sessions", { db: db.path });
        },

        async stop() {
            stopped = true;
            clearInterval(timer);
            timer = undefined;
            watcher?.close();
            watcher = undefined;
            await running;
            collector?.close();
            collector = undefined;
        },
    };
}
