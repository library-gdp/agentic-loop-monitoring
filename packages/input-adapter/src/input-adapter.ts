/**
 * Main Server의 Input Adapter입니다. Transport Unit을 받아 Decoder로 해석하고 Core의 Ingest API로 넘긴 뒤
 * Ack를 돌려줍니다. Ack 규칙은 docs/001.model/004.AGENT_LOGGING_PROTOCOL.md를 따릅니다.
 */

import { type IngestApi, type Logger, UnavailableError } from "@agentoscope/core";
import {
    type Ack,
    type AckErrorCode,
    PROTOCOL_VERSION,
    type TransportUnit,
} from "@agentoscope/plugin-api";
import { DECODERS } from "./decoder";

export interface InputAdapter {
    /**
     * 프로세스 내 호출 Transport입니다. Daemon의 Transport Client가 Transport Unit 객체를 직렬화하지 않고 넘깁니다.
     * Transport Unit의 Session Log Event를 모두 저장한 뒤에만 accepted를 돌려주며, 예외를 던지지 않습니다.
     */
    receive(unit: TransportUnit): Promise<Ack>;
}

export interface InputAdapterOptions {
    readonly ingest: IngestApi;
    readonly logger: Logger;
}

const RETRYABLE: Record<AckErrorCode, boolean> = {
    invalid_transport_unit: false,
    unsupported_version: true,
    unavailable: true,
};

export function createInputAdapter({ ingest, logger }: InputAdapterOptions): InputAdapter {
    function reject(transportUnitId: string, code: AckErrorCode, message: string): Ack {
        return {
            protocol_version: PROTOCOL_VERSION,
            transport_unit_id: transportUnitId,
            status: "rejected",
            retryable: RETRYABLE[code],
            error: { code, message },
        };
    }

    function handle(value: unknown): Ack {
        const unit =
            typeof value === "object" && value !== null && !Array.isArray(value)
                ? (value as Readonly<Record<string, unknown>>)
                : undefined;
        const transportUnitId =
            typeof unit?.transport_unit_id === "string" ? unit.transport_unit_id : "";
        const rejectAndLog = (code: AckErrorCode, message: string): Ack => {
            logger.warn("rejected a transport unit", { transportUnitId, code, message });
            return reject(transportUnitId, code, message);
        };

        if (unit === undefined) {
            return rejectAndLog("invalid_transport_unit", "transport unit must be a JSON object");
        }
        // 지원하지 않는 버전은 재시도할 수 있으므로, 버전 1의 형식으로 검사하기 전에 버전부터 봅니다.
        const version = unit.protocol_version;
        if (typeof version !== "number" || !Number.isSafeInteger(version)) {
            return rejectAndLog("invalid_transport_unit", "protocol_version must be an integer");
        }
        const decode = DECODERS.get(version);
        if (decode === undefined) {
            return rejectAndLog(
                "unsupported_version",
                `protocol_version ${version} is not supported`,
            );
        }
        const decoded = decode(unit);
        if (!decoded.ok) return rejectAndLog("invalid_transport_unit", decoded.message);

        for (const dropped of decoded.dropped) {
            logger.warn("dropped an invalid session log event", {
                transportUnitId,
                index: dropped.index,
                eventId: dropped.eventId ?? null,
                reason: dropped.reason,
            });
        }

        try {
            ingest.ingest(decoded.request);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof UnavailableError) {
                logger.info("transport unit is not accepted now", { transportUnitId, message });
            } else {
                logger.error("failed to store a transport unit", { transportUnitId, message });
            }
            return reject(transportUnitId, "unavailable", message);
        }
        return {
            protocol_version: PROTOCOL_VERSION,
            transport_unit_id: transportUnitId,
            status: "accepted",
        };
    }

    return {
        async receive(unit: TransportUnit): Promise<Ack> {
            try {
                return handle(unit);
            } catch (error) {
                // Decoder나 로그에서 예상하지 못한 오류가 나도 Ack로 답합니다.
                const transportUnitId =
                    typeof (unit as { transport_unit_id?: unknown })?.transport_unit_id === "string"
                        ? unit.transport_unit_id
                        : "";
                return reject(transportUnitId, "unavailable", String(error));
            }
        },
    };
}
