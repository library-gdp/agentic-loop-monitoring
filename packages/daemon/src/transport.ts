import type { Ack, TransportUnit } from "@alm/protocol";

/** 재시도할 수 없는 실패입니다. 이 오류로 끝나면 Transport Unit을 버립니다. */
export class NonRetryableTransportError extends Error {}

/** Daemon의 Transport Client입니다. 실패는 예외로 알립니다. */
export interface TransportClient {
  send(unit: TransportUnit): Promise<Ack>;
}

export type InProcessReceiver = (unit: TransportUnit) => Promise<Ack>;

/** Main Server Input Adapter의 함수를 직접 부릅니다. 객체를 직렬화하지 않습니다. */
export function inProcessTransport(receive: InProcessReceiver): TransportClient {
  return { send: receive };
}

/** docs/002.implementation/003.TRANSPORT.md의 REST API 바인딩입니다. */
export function restTransport(baseUrl: string): TransportClient {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/transport-units`;
  return {
    async send(unit) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(unit),
      });
      const ack = await readAck(response);
      if (ack) return ack;
      const { status } = response;
      const retryable = status >= 500 || status === 408 || status === 429 || status < 300;
      if (retryable) throw new Error(`unexpected response ${status}`);
      throw new NonRetryableTransportError(`unexpected response ${status}`);
    },
  };
}

async function readAck(response: Response): Promise<Ack | undefined> {
  try {
    const body = (await response.json()) as Partial<Ack>;
    if (body.status === "accepted" || body.status === "rejected") return body as Ack;
  } catch {
    // 본문을 Ack로 해석할 수 없으면 상태 코드로 판단합니다.
  }
  return undefined;
}
