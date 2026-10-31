import { DERIVATION_VERSION, deriveTurn } from "./derive";
import type { IngestUnit } from "./model";
import type { Repository, TurnKey } from "./repository";

export interface CoreLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

/** 파생 데이터를 다시 만드는 동안 받은 Transport Unit을 거절할 때 던집니다. */
export class RebuildingError extends Error {
  constructor() {
    super("derived data is being rebuilt");
  }
}

/** Input Adapter가 Session Log Event를 Core에 전달하기 위한 API입니다. */
export class IngestApi {
  #rebuilding = false;

  constructor(
    private readonly repository: Repository,
    private readonly logger: CoreLogger,
    private readonly now: () => number = () => Date.now() * 1000,
  ) {}

  /** derivation.version이 구성 규칙의 버전과 다르면 파생 데이터를 모두 다시 만듭니다. */
  prepare(): void {
    if (this.repository.derivationVersion() === DERIVATION_VERSION) return;
    this.#rebuilding = true;
    try {
      this.repository.transaction(() => {
        this.repository.clearDerived(DERIVATION_VERSION);
        for (const key of [...this.repository.iterateTurnKeys()]) this.#rebuildTurn(key);
      });
    } finally {
      this.#rebuilding = false;
    }
  }

  ingest(unit: IngestUnit): void {
    if (this.#rebuilding) throw new RebuildingError();
    const repository = this.repository;
    repository.transaction(() => {
      const session = repository.findOrCreateSession(unit.source.agent, unit.session.id);
      this.#fillSession(session, unit);
      const agent = repository.findOrCreateAgent(session.pk, unit.agent.id);
      if (unit.agent.parentId !== undefined) {
        if (agent.parentId === undefined) repository.fillAgent(agent.pk, unit.agent.parentId);
        else if (agent.parentId !== unit.agent.parentId) {
          this.logger.warn("agent parent differs from the stored value", {
            agent: unit.agent.id,
            stored: agent.parentId,
            received: unit.agent.parentId,
          });
        }
      }

      const ingestId = repository.insertIngest({
        transportUnitId: unit.transportUnitId,
        protocolVersion: unit.protocolVersion,
        pluginVersion: unit.source.pluginVersion,
        sessionPk: session.pk,
        agentPk: agent.pk,
        receivedAtUs: this.now(),
        eventCount: unit.eventCount,
        droppedCount: unit.droppedCount,
      });

      let stored = 0;
      for (const event of unit.events) {
        const inserted = repository.insertEvent({
          sessionPk: session.pk,
          agentPk: agent.pk,
          eventId: event.eventId,
          turnId: unit.turn.id,
          position: unit.turn.position + event.index,
          type: event.type,
          timestampUs: event.timestampUs,
          body: event.body,
          ingestId,
        });
        if (inserted) stored += 1;
      }

      const key = { agentPk: agent.pk, turnId: unit.turn.id };
      this.#rebuildTurn(key);
      if (stored > 0) repository.markOtherInProgressTurnsErrored(key);
      repository.setIngestStoredCount(ingestId, stored);
    });
  }

  #fillSession(session: { pk: number; cwd?: string; host?: string }, unit: IngestUnit): void {
    const fields: { cwd?: string; host?: string } = {};
    for (const [name, stored, received] of [
      ["cwd", session.cwd, unit.session.cwd],
      ["host", session.host, unit.source.host],
    ] as const) {
      if (received === undefined) continue;
      if (stored === undefined) fields[name] = received;
      else if (stored !== received) {
        this.logger.warn("session field differs from the stored value", {
          session: unit.session.id,
          field: name,
          stored,
          received,
        });
      }
    }
    if (Object.keys(fields).length > 0) this.repository.fillSession(session.pk, fields);
  }

  #rebuildTurn(key: TurnKey): void {
    const turn = deriveTurn(key.turnId, this.repository.iterateTurnEvents(key));
    if (!turn) {
      this.repository.replaceTurn(key, undefined);
      return;
    }
    const superseded =
      turn.status === "in_progress" &&
      this.repository.hasLaterEventInOtherTurn(key, turn.lastIngestId);
    this.repository.replaceTurn(key, superseded ? { ...turn, status: "errored" } : turn);
  }
}
