/**
 * Main Server를 이루는 모듈(Input Adapter, Core, Persistence)을 엮습니다.
 * Daemon은 receive를 프로세스 내 호출 Transport로 부르며, Main Server의 다른 모듈을 직접 부르지 않습니다.
 */

import { createIngestService, createQueryApi, type Logger, type QueryApi } from "@agentoscope/core";
import { createInputAdapter } from "@agentoscope/input-adapter";
import { openSqliteRepository } from "@agentoscope/persistence";
import type { Ack, TransportUnit } from "@agentoscope/plugin-api";

export interface MainServer {
    /** 프로세스 내 호출 Transport입니다. Transport Unit 하나를 받아 Ack를 돌려줍니다. */
    readonly receive: (unit: TransportUnit) => Promise<Ack>;
    /** Visualization이 기록된 데이터를 조회하기 위한 API입니다. */
    readonly query: QueryApi;
    /** 파생 데이터를 준비합니다. 끝나기 전에는 receive가 unavailable로 답합니다. */
    prepare(): Promise<void>;
    close(): void;
}

export interface MainServerOptions {
    readonly dataFile: string;
    readonly busyTimeoutMs: number;
    readonly logger: Logger;
    /** 지금 시각(UTC Unix epoch 마이크로초)입니다. 테스트에서 바꿉니다. */
    readonly now?: () => number;
    /** 파생 데이터를 다시 만들 때 트랜잭션 하나로 처리하는 Turn의 수입니다. */
    readonly rebuildBatchSize?: number;
}

/** 데이터 파일을 열고 스키마를 최신 버전으로 올린 Main Server를 만듭니다. */
export function openMainServer(options: MainServerOptions): MainServer {
    const repository = openSqliteRepository({
        path: options.dataFile,
        busyTimeoutMs: options.busyTimeoutMs,
    });
    const ingest = createIngestService({
        repository,
        logger: options.logger,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.rebuildBatchSize === undefined
            ? {}
            : { rebuildBatchSize: options.rebuildBatchSize }),
    });
    const adapter = createInputAdapter({ ingest, logger: options.logger });
    let closed = false;
    return {
        receive: (unit) => adapter.receive(unit),
        query: createQueryApi(repository),
        prepare: () => ingest.prepare(),
        close() {
            if (closed) return;
            closed = true;
            ingest.close();
            repository.close();
        },
    };
}
