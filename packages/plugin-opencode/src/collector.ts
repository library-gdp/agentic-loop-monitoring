import { Database, type Statement } from "bun:sqlite";
import { statSync } from "node:fs";
import type { PluginContext, PluginTransportUnit } from "@alm/plugin-api";
import type { EventRow } from "./session-machine";
import { type Checkpoint, INITIAL_CHECKPOINT, SessionMachine } from "./session-machine";
import { loadState, saveState } from "./state";

const BATCH_SIZE = 200;

interface SessionRow {
  id: string;
  parent_id: string | null;
  directory: string;
}

interface Statements {
  readonly sequences: Statement;
  readonly rows: Statement;
  readonly session: Statement;
}

/** OpenCode DB를 읽어 Transport Unit으로 넘깁니다. 읽기 전용 연결 하나를 유지합니다. */
export class Collector {
  readonly #sessions = new Map<string, SessionMachine>();
  #checkpoints: Map<string, Checkpoint>;
  #db: Database | undefined;
  #dbInode: number | undefined;
  #statements: Statements | undefined;
  #missingTableLogged = false;
  #unresolved = new Set<string>();
  #saved = "";

  constructor(
    private readonly path: string,
    private readonly stateFile: string,
    private readonly context: Pick<PluginContext, "submit" | "logger">,
    private readonly stopped: () => boolean,
  ) {
    this.#checkpoints = loadState(stateFile, context.logger);
  }

  close(): void {
    this.#save();
    this.#closeDb();
  }

  #closeDb(): void {
    this.#statements = undefined;
    this.#db?.close();
    this.#db = undefined;
  }

  /** DB가 아직 없으면 false입니다. 파일이 바뀌었으면 다시 엽니다. */
  #open(): boolean {
    let inode: number;
    try {
      inode = statSync(this.path).ino;
    } catch {
      this.#closeDb();
      return false;
    }
    if (this.#db && inode === this.#dbInode) return true;
    this.#closeDb();
    this.#db = new Database(this.path, { readonly: true });
    this.#db.exec("PRAGMA busy_timeout = 1000");
    this.#db.exec("PRAGMA mmap_size = 0");
    this.#dbInode = inode;
    return true;
  }

  #prepare(): Statements | undefined {
    if (this.#statements) return this.#statements;
    const db = this.#db as Database;
    const tables = db
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('event', 'event_sequence', 'session')`,
      )
      .all() as { name: string }[];
    if (tables.length < 3) {
      if (!this.#missingTableLogged) {
        this.context.logger.warn("opencode database has no event tables", { path: this.path });
        this.#missingTableLogged = true;
      }
      return undefined;
    }
    this.#statements = {
      sequences: db.query("SELECT aggregate_id, seq FROM event_sequence"),
      rows: db.query(
        `SELECT id, seq, type, data FROM event
         WHERE aggregate_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`,
      ),
      session: db.query("SELECT id, parent_id, directory FROM session WHERE id = ?"),
    };
    return this.#statements;
  }

  /** 저장한 위치 이후의 행을 수집합니다. 호출이 겹치지 않아야 합니다. */
  async collect(): Promise<void> {
    if (!this.#open()) return;
    const statements = this.#prepare();
    if (!statements) return;

    const latest = new Map<string, number>();
    for (const row of statements.sequences.all() as { aggregate_id: string; seq: number }[]) {
      latest.set(row.aggregate_id, row.seq);
    }

    for (const id of [...this.#checkpoints.keys(), ...this.#sessions.keys()]) {
      if (latest.has(id)) continue;
      this.#checkpoints.delete(id);
      this.#sessions.delete(id);
    }

    for (const [id, seq] of latest) {
      if (this.stopped()) break;
      await this.#collectSession(id, seq, statements);
    }
    this.#save();
  }

  async #collectSession(id: string, latestSeq: number, statements: Statements): Promise<void> {
    let machine = this.#sessions.get(id);
    if (machine?.seq === latestSeq) return;
    const saved = this.#checkpoints.get(id);
    if (!machine && saved?.seq === latestSeq) return;

    if (!machine || machine.seq > latestSeq) {
      // Session Log가 줄었으면 저장한 위치를 믿을 수 없으므로 처음부터 다시 수집합니다.
      const shrunk = (machine?.seq ?? saved?.seq ?? -1) > latestSeq;
      machine = this.#createMachine(id, shrunk ? INITIAL_CHECKPOINT : saved, statements);
      if (!machine) return;
      this.#sessions.set(id, machine);
    }

    while (machine.seq < latestSeq && !this.stopped()) {
      const rows = statements.rows.all(id, machine.seq, latestSeq, BATCH_SIZE) as EventRow[];
      if (rows.length === 0) break;
      for (const row of rows) machine.accept(row);
      this.#checkpoints.set(id, machine.checkpoint);
      // Daemon의 전송과 Visualization이 이벤트 루프를 쓸 수 있게 묶음마다 양보합니다.
      await Bun.sleep(0);
    }
  }

  #createMachine(
    id: string,
    checkpoint: Checkpoint | undefined,
    statements: Statements,
  ): SessionMachine | undefined {
    const session = statements.session.get(id) as SessionRow | null;
    if (!session) return undefined;
    const root = this.#findRoot(session, statements);
    if (!root) {
      if (!this.#unresolved.has(id)) {
        this.#unresolved.add(id);
        this.context.logger.warn("cannot find the root session yet", { session: id });
      }
      return undefined;
    }
    this.#unresolved.delete(id);

    const agent: PluginTransportUnit["agent"] = {
      id: session.id,
      ...(session.parent_id === null ? {} : { parent_id: session.parent_id }),
    };
    return new SessionMachine(
      {
        session: { id: root.id, cwd: root.directory },
        agent,
        submit: (unit) => this.context.submit(unit),
        warn: (message, details) => this.context.logger.warn(message, { session: id, ...details }),
      },
      checkpoint,
    );
  }

  #findRoot(session: SessionRow, statements: Statements): SessionRow | undefined {
    const visited = new Set<string>([session.id]);
    let current = session;
    while (current.parent_id !== null) {
      if (visited.has(current.parent_id)) return undefined;
      visited.add(current.parent_id);
      const parent = statements.session.get(current.parent_id) as SessionRow | null;
      if (!parent) return undefined;
      current = parent;
    }
    return current;
  }

  #save(): void {
    const serialized = JSON.stringify(Object.fromEntries(this.#checkpoints));
    if (serialized === this.#saved) return;
    saveState(this.stateFile, serialized, this.context.logger);
    this.#saved = serialized;
  }
}
