import type { IngestRequest } from "@agentoscope/core";
import { decodeV1 } from "./decoder-v1";

/** 잘못되어 버린 Session Log Event입니다. */
export interface DroppedEvent {
    /** Transport Unit의 events 안에서의 순서입니다. */
    readonly index: number;
    readonly eventId?: string;
    readonly reason: string;
}

export type DecodeResult =
    | {
          readonly ok: true;
          readonly request: IngestRequest;
          readonly dropped: readonly DroppedEvent[];
      }
    | { readonly ok: false; readonly message: string };

/** Transport Unit을 해석해 Ingest API로 넘길 요청을 만듭니다. */
export type Decoder = (unit: Readonly<Record<string, unknown>>) => DecodeResult;

/** Agent Logging Protocol의 버전마다 Decoder를 하나씩 둡니다. */
export const DECODERS: ReadonlyMap<number, Decoder> = new Map([[1, decodeV1]]);
