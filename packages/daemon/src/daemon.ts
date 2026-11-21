/**
 * Client Adapter Daemon입니다. Plugin을 불러와 시작하고, Plugin이 넘긴 Transport Unit을 Main Server에 보냅니다.
 * docs/001.model/006.CLIENT_ADAPTER_DAEMON.md와 docs/002.implementation/007.CLIENT_ADAPTER_DAEMON.md를 따릅니다.
 */

import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin, PluginContext } from "@agentoscope/plugin-api";
import { acquireLock, type DaemonLock } from "./lock";
import { errorMessage, type Logger, withDetails } from "./logger";
import { loadPlugins, type PluginCollection } from "./plugin-loader";
import { createSender, type RetryPolicy, type Transport } from "./sender";

export interface DaemonOptions {
    /** Daemon이 쓰는 파일(잠금 파일, Plugin의 상태 디렉터리)을 두는 디렉터리입니다. */
    readonly stateDirectory: string;
    /** 빌드한 Plugin을 두는 디렉터리입니다. */
    readonly pluginDirectory: string;
    /** 시작할 Plugin의 에이전트 id입니다. 비우면(undefined) 등록된 Plugin을 모두 시작합니다. */
    readonly plugins?: readonly string[];
    readonly transport: Transport;
    readonly ackTimeoutMs: number;
    readonly retry: RetryPolicy;
    /** Transport Unit의 source.host입니다. */
    readonly host?: string;
    readonly logger: Logger;
    /** Plugin의 stop이 끝나기를 기다리는 최대 시간(밀리초)입니다. */
    readonly stopTimeoutMs?: number;
    /** 종료할 때 전송 대기열에 남은 Transport Unit을 보내는 최대 시간(밀리초)입니다. */
    readonly drainTimeoutMs?: number;
    /** transport_unit_id를 만듭니다. 테스트에서 바꿉니다. */
    readonly newId?: () => string;
}

export interface Daemon {
    /** 시작한 Plugin의 에이전트 id입니다. */
    readonly started: readonly string[];
    /** 전송 대기열에 남은 Transport Unit의 수입니다. */
    readonly pending: number;
    /** Plugin을 멈추고, 남은 Transport Unit을 보낸 뒤 잠금을 풉니다. */
    stop(): Promise<void>;
}

export const DEFAULT_STOP_TIMEOUT_MS = 10_000;
export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

/** 디렉터리를 만들고 권한을 0700으로 맞춥니다. Session Log 원문에서 나온 상태를 다른 계정이 읽지 못하게 합니다. */
async function privateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<"timeout">((resolve) => {
                timer = setTimeout(() => resolve("timeout"), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Daemon을 시작합니다. 같은 상태 디렉터리를 쓰는 Daemon이 이미 실행 중이면 DaemonAlreadyRunningError를 던집니다.
 * Plugin을 불러오거나 시작하지 못하면 로그를 남기고 그 Plugin만 건너뜁니다.
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
    const { logger } = options;
    await privateDirectory(options.stateDirectory);
    const lock: DaemonLock = acquireLock(options.stateDirectory);
    try {
        const collection: PluginCollection = await loadPlugins(options.pluginDirectory, logger);
        const sender = createSender({
            transport: options.transport,
            ackTimeoutMs: options.ackTimeoutMs,
            retry: options.retry,
            logger,
            ...(options.host === undefined ? {} : { host: options.host }),
            ...(options.newId === undefined ? {} : { newId: options.newId }),
        });

        const wanted = options.plugins ?? [...collection.keys()];
        const running: { plugin: Plugin; stopped: { value: boolean } }[] = [];
        for (const agent of new Set(wanted)) {
            const plugin = collection.get(agent);
            if (plugin === undefined) {
                logger.error("no plugin is registered for an enabled agent", {
                    agent,
                    pluginDirectory: options.pluginDirectory,
                });
                continue;
            }
            const stopped = { value: false };
            const source = { agent: plugin.agent, pluginVersion: plugin.version };
            const pluginLogger = withDetails(logger, { agent: plugin.agent });
            try {
                const stateDirectory = join(options.stateDirectory, "plugins", plugin.agent);
                await privateDirectory(stateDirectory);
                const context: PluginContext = {
                    submit(unit) {
                        if (stopped.value) return;
                        sender.enqueue(source, unit);
                    },
                    logger: pluginLogger,
                    stateDirectory,
                };
                await plugin.start(context);
                running.push({ plugin, stopped });
                logger.info("started a plugin", { agent: plugin.agent, version: plugin.version });
            } catch (error) {
                stopped.value = true;
                logger.error("cannot start a plugin", {
                    agent: plugin.agent,
                    message: errorMessage(error),
                });
            }
        }

        let stopping: Promise<void> | undefined;
        return {
            started: running.map(({ plugin }) => plugin.agent),
            get pending() {
                return sender.pending;
            },
            stop() {
                stopping ??= (async () => {
                    const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
                    await Promise.all(
                        running.map(async ({ plugin, stopped }) => {
                            try {
                                const result = await withTimeout(plugin.stop(), stopTimeoutMs);
                                if (result === "timeout") {
                                    logger.error("a plugin did not stop in time", {
                                        agent: plugin.agent,
                                        timeoutMs: stopTimeoutMs,
                                    });
                                }
                            } catch (error) {
                                logger.error("a plugin failed to stop", {
                                    agent: plugin.agent,
                                    message: errorMessage(error),
                                });
                            } finally {
                                stopped.value = true;
                            }
                        }),
                    );
                    await sender.close(options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
                    lock.release();
                    logger.info("daemon stopped");
                })();
                return stopping;
            },
        };
    } catch (error) {
        lock.release();
        throw error;
    }
}
