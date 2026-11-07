import { type CoreLogger, type IngestApi, RebuildingError } from "@alm/core";
import { type Ack, PROTOCOL_VERSION, type RejectedAck } from "@alm/protocol";
import { Hono } from "hono";
import { decodeTransportUnit } from "./decoder";

function rejected(
  transportUnitId: string,
  code: RejectedAck["error"]["code"],
  retryable: boolean,
  message?: string,
): RejectedAck {
  return {
    protocol_version: PROTOCOL_VERSION,
    transport_unit_id: transportUnitId,
    status: "rejected",
    retryable,
    error: message === undefined ? { code } : { code, message },
  };
}

/** Main Server의 entrypoint입니다. Transport Unit을 받아 Ingest API로 넘기고 Ack를 만듭니다. */
export class InputAdapter {
  constructor(
    private readonly ingest: IngestApi,
    private readonly logger: CoreLogger,
  ) {}

  /** 프로세스 내 호출 Transport의 수신 함수입니다. */
  receive = async (input: unknown): Promise<Ack> => this.#process(input);

  #process(input: unknown): Ack {
    const decoded = decodeTransportUnit(input, this.logger);
    if (decoded.kind === "invalid") {
      this.logger.warn("rejected an invalid transport unit", { message: decoded.message });
      return rejected(decoded.transportUnitId, "invalid_transport_unit", false, decoded.message);
    }
    if (decoded.kind === "unsupported_version") {
      this.logger.warn("rejected an unsupported protocol version", {
        transportUnitId: decoded.transportUnitId,
      });
      return rejected(decoded.transportUnitId, "unsupported_version", true);
    }
    try {
      this.ingest.ingest(decoded.unit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof RebuildingError)) {
        this.logger.error("failed to store a transport unit", { message });
      }
      return rejected(decoded.unit.transportUnitId, "unavailable", true, message);
    }
    return {
      protocol_version: PROTOCOL_VERSION,
      transport_unit_id: decoded.unit.transportUnitId,
      status: "accepted",
    };
  }

  /** REST API Transport의 라우트입니다. */
  restRoutes(): Hono {
    const app = new Hono();
    app.post("/v1/transport-units", async (context) => {
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        const ack = rejected("", "invalid_transport_unit", false, "body is not JSON");
        return context.json(ack, 400);
      }
      const ack = this.#process(body);
      return context.json(ack, statusOf(ack));
    });
    return app;
  }
}

function statusOf(ack: Ack): 200 | 400 | 422 | 503 {
  if (ack.status === "accepted") return 200;
  switch (ack.error.code) {
    case "invalid_transport_unit":
      return 400;
    case "unsupported_version":
      return 422;
    case "unavailable":
      return 503;
  }
}
