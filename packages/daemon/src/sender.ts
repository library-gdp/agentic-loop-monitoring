/**
 * Plugin이 넘긴 Transport Unit을 넘겨받은 순서대로 하나씩 Main Server에 보내고 Ack를 처리합니다.
 * docs/001.model/006.CLIENT_ADAPTER_DAEMON.md의 "Session Log Event 전송"을 따릅니다.
 */

import {
    type Ack,
    type PluginTransportUnit,
    PROTOCOL_VERSION,
    type TransportUnit,
} from "@agentoscope/plugin-api";
import { errorMessage, type Logger } from "./logger";

/** Transport Client입니다. Transport Unit 하나를 Main Server에 보내고 그 Ack로 끝납니다. */
export type Transport = (unit: TransportUnit) => Promise<Ack>;

export interface RetryPolicy {
    /** 재시도 가능한 실패 뒤 같은 Transport Unit을 다시 보내는 횟수입니다. 첫 전송은 세지 않습니다. */
    readonly count: number;
    /** 첫 재시도 전에 기다리는 시간(밀리초)입니다. 재시도할 때마다 두 배로 늘립니다. */
    readonly intervalMs: number;
    /** 재시도 간격의 상한(밀리초)입니다. */
    readonly maxIntervalMs: number;
}

export interface SenderOptions {
    readonly transport: Transport;
    /** Transport Unit을 보낸 뒤 Ack를 기다리는 최대 시간(밀리초)입니다. */
    readonly ackTimeoutMs: number;
    readonly retry: RetryPolicy;
    /** Transport Unit의 source.host입니다. */
    readonly host?: string;
    readonly logger: Logger;
    /** transport_unit_id를 만듭니다. 테스트에서 바꿉니다. */
    readonly newId?: () => string;
}

/** Transport Unit을 보낸 Plugin입니다. source를 채우는 데 씁니다. */
export interface UnitSource {
    readonly agent: string;
    readonly pluginVersion: string;
}

interface Queued {
    readonly source: UnitSource;
    readonly unit: PluginTransportUnit;
}

type Outcome =
    | { readonly kind: "accepted" }
    | { readonly kind: "retryable"; readonly reason: string; readonly details?: object }
    | { readonly kind: "rejected"; readonly reason: string; readonly details?: object };

export interface Sender {
    /** Transport Unit을 전송 대기열에 넣고 바로 돌아옵니다. */
    enqueue(source: UnitSource, unit: PluginTransportUnit): void;
    /** 대기열에 남은 Transport Unit의 수입니다. 보내는 중인 것도 셉니다. */
    readonly pending: number;
    /**
     * 대기열이 빌 때까지 기다리되 timeoutMs가 지나면 보내기를 멈춥니다. 남은 Transport Unit은 로그를 남기고 버립니다.
     * 이 뒤에 넣은 Transport Unit은 보내지 않습니다.
     */
    close(timeoutMs: number): Promise<void>;
}

export function createSender(options: SenderOptions): Sender {
    const { logger } = options;
    const newId = options.newId ?? (() => crypto.randomUUID());
    const queue: Queued[] = [];
    let sending = false;
    let closed = false;
    /** 보내는 중인 Transport Unit의 수(0 또는 1)입니다. */
    let inFlight = 0;
    let idle: (() => void) | undefined;
    /** 재시도를 기다리는 중이면 기다림을 끝냅니다. */
    let wake: (() => void) | undefined;

    function sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(done, ms);
            function done() {
                clearTimeout(timer);
                wake = undefined;
                resolve();
            }
            wake = done;
        });
    }

    async function sendOnce(item: Queued): Promise<Outcome> {
        const id = newId();
        const unit: TransportUnit = {
            ...item.unit,
            protocol_version: PROTOCOL_VERSION,
            transport_unit_id: id,
            source: {
                agent: item.source.agent,
                plugin_version: item.source.pluginVersion,
                ...(options.host === undefined ? {} : { host: options.host }),
            },
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        let ack: Ack | "timeout";
        try {
            ack = await Promise.race([
                options.transport(unit),
                new Promise<"timeout">((resolve) => {
                    timer = setTimeout(() => resolve("timeout"), options.ackTimeoutMs);
                }),
            ]);
        } catch (error) {
            return {
                kind: "retryable",
                reason: "transport failed",
                details: { message: errorMessage(error) },
            };
        } finally {
            clearTimeout(timer);
        }
        if (ack === "timeout") {
            return {
                kind: "retryable",
                reason: "ack timed out",
                details: { timeoutMs: options.ackTimeoutMs },
            };
        }
        if (typeof ack !== "object" || ack === null || ack.transport_unit_id !== id) {
            return { kind: "retryable", reason: "ack does not answer the transport unit" };
        }
        if (ack.status === "accepted") return { kind: "accepted" };
        const details = { code: ack.error?.code ?? null, message: ack.error?.message ?? null };
        return ack.retryable === true
            ? { kind: "retryable", reason: "transport unit rejected", details }
            : { kind: "rejected", reason: "transport unit rejected", details };
    }

    async function deliver(item: Queued): Promise<void> {
        const about = {
            agent: item.source.agent,
            sessionId: item.unit.session.id,
            agentId: item.unit.agent.id,
            turnId: item.unit.turn.id,
            position: item.unit.turn.position,
        };
        for (let attempt = 0; ; attempt++) {
            if (attempt > 0) {
                if (closed) break;
                await sleep(
                    Math.min(
                        options.retry.intervalMs * 2 ** (attempt - 1),
                        options.retry.maxIntervalMs,
                    ),
                );
                if (closed) break;
            }
            const outcome = await sendOnce(item);
            switch (outcome.kind) {
                case "accepted":
                    return;
                case "rejected":
                    logger.error("dropped a transport unit the main server rejected", {
                        ...about,
                        ...outcome.details,
                    });
                    return;
                case "retryable":
                    logger.warn(outcome.reason, {
                        ...about,
                        attempt: attempt + 1,
                        ...outcome.details,
                    });
                    if (attempt >= options.retry.count) {
                        logger.error("dropped a transport unit after all retries failed", {
                            ...about,
                            attempts: attempt + 1,
                        });
                        return;
                    }
            }
        }
        logger.error("dropped a transport unit because the daemon is stopping", about);
    }

    async function pump(): Promise<void> {
        sending = true;
        try {
            for (let item = queue.shift(); item !== undefined && !closed; item = queue.shift()) {
                inFlight = 1;
                try {
                    await deliver(item);
                } catch (error) {
                    logger.error("cannot send a transport unit", { message: errorMessage(error) });
                } finally {
                    inFlight = 0;
                }
            }
        } finally {
            sending = false;
            idle?.();
        }
    }

    return {
        enqueue(source, unit) {
            if (closed) {
                logger.warn("ignored a transport unit submitted after the daemon stopped", {
                    agent: source.agent,
                });
                return;
            }
            queue.push({ source, unit });
            if (!sending) void pump();
        },
        get pending() {
            return queue.length + inFlight;
        },
        async close(timeoutMs) {
            if (sending) {
                const drained = new Promise<void>((resolve) => {
                    idle = resolve;
                });
                let timer: ReturnType<typeof setTimeout> | undefined;
                const expired = new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, timeoutMs);
                });
                await Promise.race([drained, expired]);
                clearTimeout(timer);
            }
            closed = true;
            wake?.();
            if (queue.length > 0) {
                logger.error(
                    "dropped transport units that were not sent before the daemon stopped",
                    {
                        count: queue.length,
                    },
                );
                queue.length = 0;
            }
        },
    };
}
