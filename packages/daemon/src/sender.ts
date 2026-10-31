import type { PluginTransportUnit } from "@alm/plugin-api";
import { PROTOCOL_VERSION, type TransportUnit } from "@alm/protocol";
import type { DaemonLogger } from "./logger";
import { NonRetryableTransportError, type TransportClient } from "./transport";

export interface SenderOptions {
  readonly ackTimeoutMs: number;
  /** 첫 전송 뒤 다시 보내는 횟수입니다. */
  readonly retryCount: number;
  /** 첫 재시도 간격입니다. 재시도할 때마다 두 배로 늘립니다. */
  readonly retryIntervalMs: number;
  readonly host?: string;
}

interface QueueItem {
  readonly source: TransportUnit["source"];
  readonly unit: PluginTransportUnit;
}

/** Transport Unit을 하나씩 보내고 Ack를 기다립니다. */
export class Sender {
  readonly #queue: QueueItem[] = [];
  #head = 0;
  #running: Promise<void> | undefined;
  #closed = false;
  #wakeRetry: (() => void) | undefined;

  constructor(
    private readonly transport: TransportClient,
    private readonly options: SenderOptions,
    private readonly logger: DaemonLogger,
  ) {}

  submit(agent: string, pluginVersion: string, unit: PluginTransportUnit): void {
    const { host } = this.options;
    const source = {
      agent,
      plugin_version: pluginVersion,
      ...(host === undefined ? {} : { host }),
    };
    this.#queue.push({ source, unit });
    this.#running ??= this.#drain().finally(() => {
      this.#running = undefined;
    });
  }

  /** 대기열이 빌 때까지 기다립니다. timeoutMs가 지나면 재시도 대기를 끊고 남은 것을 포기합니다. */
  async close(timeoutMs: number): Promise<void> {
    const running = this.#running;
    if (!running) {
      this.#closed = true;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      running,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    this.#closed = true;
    this.#wakeRetry?.();
    const left = this.#queue.length - this.#head;
    if (left > 0) this.logger.warn("dropped queued transport units at shutdown", { count: left });
  }

  async #drain(): Promise<void> {
    while (!this.#closed && this.#head < this.#queue.length) {
      const item = this.#queue[this.#head] as QueueItem;
      await this.#deliver(item);
      this.#head += 1;
      if (this.#head === this.#queue.length) {
        this.#queue.length = 0;
        this.#head = 0;
      }
    }
  }

  async #deliver(item: QueueItem): Promise<void> {
    const unit: TransportUnit = {
      ...item.unit,
      protocol_version: PROTOCOL_VERSION,
      transport_unit_id: crypto.randomUUID(),
      source: item.source,
    };
    const details = { transportUnitId: unit.transport_unit_id, agent: unit.source.agent };
    for (let attempt = 0; attempt <= this.options.retryCount && !this.#closed; attempt += 1) {
      if (attempt > 0) await this.#sleep(this.options.retryIntervalMs * 2 ** (attempt - 1));
      try {
        const ack = await this.#send(unit);
        if (ack.status === "accepted") return;
        if (!ack.retryable) {
          this.logger.error("dropped a rejected transport unit", { ...details, error: ack.error });
          return;
        }
        this.logger.warn("transport unit was rejected", { ...details, attempt, error: ack.error });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof NonRetryableTransportError) {
          this.logger.error("dropped a transport unit", { ...details, message });
          return;
        }
        this.logger.warn("failed to send a transport unit", { ...details, attempt, message });
      }
    }
    this.logger.error("gave up sending a transport unit", details);
  }

  #send(unit: TransportUnit) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("ack timeout")), this.options.ackTimeoutMs);
    });
    const ack = Promise.resolve().then(() => this.transport.send(unit));
    return Promise.race([ack, timeout]).finally(() => clearTimeout(timer));
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.#wakeRetry = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
