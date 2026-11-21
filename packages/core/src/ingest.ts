import { DERIVATION_VERSION, deriveTurn } from "./derive";
import type { Logger } from "./logger";
import type { IngestRequest, IngestResult } from "./model";
import type { Repository, TurnKey, WriteTransaction } from "./repository";

/** Input Adapter가 Session Log Event를 Core에 전달하기 위한 API입니다. */
export interface IngestApi {
    /**
     * Transport Unit 하나를 원자적으로 저장하고, 그 Turn의 파생 데이터를 다시 만듭니다.
     * 이미 받은 event id의 Session Log Event는 건너뛰므로 같은 Transport Unit을 여러 번 받아도 결과가 같습니다.
     * 저장하지 못하면 아무것도 남기지 않고 예외를 던집니다.
     */
    ingest(request: IngestRequest): IngestResult;
}

/** Ingest API에 더해, 시작할 때 파생 데이터를 준비하는 일을 맡습니다. */
export interface IngestService extends IngestApi {
    /**
     * 파생 데이터를 만든 구성 규칙의 버전이 지금 버전과 다르면 파생 데이터를 모두 다시 만듭니다.
     * 끝나기 전에는 ingest가 UnavailableError를 던집니다.
     */
    prepare(): Promise<void>;
    /** 더 받지 않고, 진행 중인 재구성을 멈춥니다. */
    close(): void;
}

export type UnavailableReason = "not_ready" | "rebuilding" | "closed";

const UNAVAILABLE_MESSAGES: Record<UnavailableReason, string> = {
    not_ready: "derived data is not prepared yet",
    rebuilding: "derived data is being rebuilt",
    closed: "main server is closing",
};

/** 지금은 Transport Unit을 받을 수 없을 때 던집니다. 같은 Transport Unit을 다시 보내면 받을 수 있습니다. */
export class UnavailableError extends Error {
    override readonly name = "UnavailableError";

    constructor(readonly reason: UnavailableReason) {
        super(UNAVAILABLE_MESSAGES[reason]);
    }
}

export interface IngestServiceOptions {
    readonly repository: Repository;
    readonly logger: Logger;
    /** 지금 시각(UTC Unix epoch 마이크로초)입니다. */
    readonly now?: () => number;
    /** 파생 데이터를 다시 만들 때 쓰기 트랜잭션 하나로 처리하는 Turn의 수입니다. */
    readonly rebuildBatchSize?: number;
}

export function createIngestService(options: IngestServiceOptions): IngestService {
    return new DefaultIngestService(options);
}

type State = UnavailableReason | "ready";

class DefaultIngestService implements IngestService {
    readonly #repository: Repository;
    readonly #logger: Logger;
    readonly #now: () => number;
    readonly #rebuildBatchSize: number;
    #state: State = "not_ready";

    constructor(options: IngestServiceOptions) {
        this.#repository = options.repository;
        this.#logger = options.logger;
        this.#now = options.now ?? (() => Date.now() * 1000);
        this.#rebuildBatchSize = options.rebuildBatchSize ?? 200;
    }

    async prepare(): Promise<void> {
        if (this.#state !== "not_ready") throw new Error(`cannot prepare in state ${this.#state}`);
        const version = this.#repository.derivationVersion();
        if (version === DERIVATION_VERSION) {
            this.#state = "ready";
            return;
        }

        this.#state = "rebuilding";
        this.#logger.info("rebuilding derived data", {
            fromVersion: version ?? null,
            toVersion: DERIVATION_VERSION,
        });
        this.#repository.write((tx) => tx.clearDerived());
        let after: TurnKey | undefined;
        let turns = 0;
        for (;;) {
            const keys = this.#repository.listTurnKeys(after, this.#rebuildBatchSize);
            if (keys.length === 0) break;
            this.#repository.write((tx) => {
                for (const key of keys) this.#rebuildTurn(tx, key);
            });
            turns += keys.length;
            after = keys[keys.length - 1];
            // 다시 만드는 동안에도 다른 일이 이벤트 루프를 쓸 수 있게 합니다.
            await new Promise((resolve) => setImmediate(resolve));
            if (this.#isClosed()) return;
        }
        this.#repository.write((tx) => tx.setDerivationVersion(DERIVATION_VERSION));
        this.#state = "ready";
        this.#logger.info("rebuilt derived data", { turns });
    }

    ingest(request: IngestRequest): IngestResult {
        if (this.#state !== "ready") throw new UnavailableError(this.#state);
        const droppedCount = request.eventCount - request.events.length;
        const warnings: [string, Record<string, unknown>][] = [];
        const result = this.#repository.write((tx) => {
            const session = tx.ensureSession(request.source.agentKind, request.session.id);
            const where = { agentKind: request.source.agentKind, sessionId: request.session.id };
            const conflict = (field: string) => (stored: string, received: string) => {
                warnings.push([
                    "received value differs from the stored value",
                    { ...where, agentId: request.agent.id, field, stored, received },
                ]);
            };
            const cwd = fillable(session.cwd, request.session.cwd, conflict("session.cwd"));
            const host = fillable(session.host, request.source.host, conflict("source.host"));
            if (cwd !== undefined || host !== undefined) {
                tx.fillSession(session.pk, {
                    ...(cwd === undefined ? {} : { cwd }),
                    ...(host === undefined ? {} : { host }),
                });
            }

            const agent = tx.ensureAgent(session.pk, request.agent.id);
            const parentId = fillable(
                agent.parentId,
                request.agent.parentId,
                conflict("agent.parent_id"),
            );
            if (parentId !== undefined) tx.fillAgentParent(agent.pk, parentId);

            const ingestId = tx.addIngest({
                transportUnitId: request.transportUnitId,
                protocolVersion: request.protocolVersion,
                pluginVersion: request.source.pluginVersion,
                sessionPk: session.pk,
                agentPk: agent.pk,
                receivedAtUs: this.#now(),
                eventCount: request.eventCount,
                droppedCount,
            });

            let storedCount = 0;
            for (const event of request.events) {
                const stored = tx.addEvent({
                    sessionPk: session.pk,
                    agentPk: agent.pk,
                    eventId: event.eventId,
                    turnId: request.turn.id,
                    position: request.turn.position + event.index,
                    type: event.type,
                    timestampUs: event.timestampUs,
                    body: event.body,
                    ingestId,
                });
                if (stored) storedCount += 1;
            }

            this.#rebuildTurn(tx, { agentPk: agent.pk, turnId: request.turn.id });
            // 다른 Turn의 Session Log Event를 새로 받았으므로, 진행 중이던 다른 Turn은 errored입니다.
            // 이미 저장되어 건너뛴 것은 처음 받은 순서를 유지하므로 이 규칙에 들지 않습니다.
            if (storedCount > 0) tx.markInProgressTurnsErrored(agent.pk, request.turn.id);
            tx.setIngestStoredCount(ingestId, storedCount);
            return { storedCount, droppedCount };
        });
        for (const [message, details] of warnings) this.#logger.warn(message, details);
        return result;
    }

    close(): void {
        this.#state = "closed";
    }

    #isClosed(): boolean {
        return this.#state === "closed";
    }

    /** Turn 하나의 파생 데이터를 그 Turn의 Session Log Event로 다시 만듭니다. */
    #rebuildTurn(tx: WriteTransaction, key: TurnKey): void {
        const derived = deriveTurn(key.turnId, tx.iterateTurnEvents(key));
        if (derived === undefined) {
            tx.replaceTurn(key, undefined);
            return;
        }
        const { turn, firstIngestId } = derived;
        // 이 Turn의 Session Log Event보다 나중에 받은 다른 Turn의 Session Log Event가 있으면,
        // 최종 응답도 중단도 없이 다음 Turn이 시작된 것이므로 errored입니다.
        const superseded =
            turn.status === "in_progress" && tx.hasOtherTurnEventReceivedAfter(key, firstIngestId);
        tx.replaceTurn(key, superseded ? { ...turn, status: "errored" } : turn);
    }
}

/**
 * Session과 Agent의 필드 채우기 규칙입니다. 비어 있는 필드는 받은 값으로 채우고, 이미 값이 있으면 바꾸지 않습니다.
 * 채울 값을 돌려주며, 다른 값이 오면 onConflict를 부릅니다.
 */
function fillable(
    stored: string | undefined,
    received: string | undefined,
    onConflict: (stored: string, received: string) => void,
): string | undefined {
    if (received === undefined) return undefined;
    if (stored === undefined) return received;
    if (stored !== received) onConflict(stored, received);
    return undefined;
}
