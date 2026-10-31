import { type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";

const RESCAN_INTERVAL_MS = 30_000;

/** DB 디렉터리의 WAL 변경과 30초 주기로 collect를 부릅니다. 수집을 겹쳐 실행하지 않습니다. */
export class Trigger {
  #watcher: FSWatcher | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #dirty = false;
  #stopped = false;

  constructor(
    private readonly databasePath: string,
    private readonly collect: () => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    this.#timer = setInterval(() => {
      this.#watch();
      this.fire();
    }, RESCAN_INTERVAL_MS);
    this.#watch();
    this.fire();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#watcher?.close();
    this.#watcher = undefined;
    await this.#running;
  }

  fire(): void {
    if (this.#stopped) return;
    if (this.#running) {
      this.#dirty = true;
      return;
    }
    this.#running = this.#loop().finally(() => {
      this.#running = undefined;
    });
  }

  async #loop(): Promise<void> {
    do {
      this.#dirty = false;
      try {
        await this.collect();
      } catch (error) {
        this.onError(error);
      }
    } while (this.#dirty && !this.#stopped);
  }

  #watch(): void {
    if (this.#watcher || this.#stopped) return;
    const wal = `${basename(this.databasePath)}-wal`;
    try {
      this.#watcher = watch(dirname(this.databasePath), (_event, name) => {
        if (name === null || name === wal) this.fire();
      });
      this.#watcher.on("error", () => {
        this.#watcher?.close();
        this.#watcher = undefined;
      });
    } catch {
      // OpenCode를 아직 실행하지 않아 디렉터리가 없으면 다음 주기에 다시 겁니다.
      this.#watcher = undefined;
    }
  }
}
