import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { IngestApi, QueryApi } from "@alm/core";
import {
  acquireLock,
  FileLogger,
  inProcessTransport,
  loadPlugins,
  releaseLock,
  restTransport,
  Sender,
  startPlugins,
  stopPlugins,
  type TransportClient,
} from "@alm/daemon";
import { InputAdapter } from "@alm/input-adapter";
import { SqliteRepository } from "@alm/persistence";
import { createVisualizationApp } from "@alm/visualization";
import { bundleSpa } from "@alm/visualization/spa-bundle" with { type: "macro" };
import type { Config } from "./config";
import { writeConnection } from "./connection";

const SHUTDOWN_TIMEOUT_MS = 5_000;

const SPA = bundleSpa();

interface MainServer {
  readonly adapter: InputAdapter;
  stop(): Promise<void>;
}

function startMainServer(config: Config, logger: FileLogger): MainServer {
  mkdirSync(join(config.dataFile, ".."), { recursive: true, mode: 0o700 });
  const repository = new SqliteRepository({
    path: config.dataFile,
    busyTimeoutMs: config.storage.busyTimeoutMs,
  });
  const ingest = new IngestApi(repository, logger);
  ingest.prepare();
  const adapter = new InputAdapter(ingest, logger);

  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  let host = "";
  const app = createVisualizationApp({
    query: new QueryApi(repository),
    spa: SPA,
    token,
    host: () => host,
  });
  const visualization = Bun.serve({
    hostname: "127.0.0.1",
    port: config.visualization.port,
    fetch: app.fetch,
  });
  host = `127.0.0.1:${visualization.port}`;
  writeConnection(config.stateDirectory, { url: `http://${host}/`, token });
  logger.info("visualization is listening", { host });

  const rest =
    config.role === "server"
      ? Bun.serve({
          hostname: config.server.host,
          port: config.server.port,
          fetch: adapter.restRoutes().fetch,
        })
      : undefined;
  if (rest) logger.info("rest transport is listening", { port: rest.port });

  return {
    adapter,
    async stop() {
      await Promise.all([visualization.stop(), rest?.stop()]);
      repository.close();
    },
  };
}

/** Daemon과 Main Server를 실행합니다. 종료 신호를 받으면 돌아옵니다. */
export async function run(config: Config): Promise<void> {
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(config.stateDirectory, "daemon.lock");
  if (!acquireLock(lockPath)) {
    console.error(`another daemon is using ${config.stateDirectory}`);
    process.exitCode = 1;
    return;
  }

  const logger = new FileLogger(join(config.stateDirectory, "daemon.log"));
  const server = config.role === "daemon" ? undefined : startMainServer(config, logger);

  let transport: TransportClient | undefined;
  if (config.role !== "server") {
    transport =
      config.transport.kind === "rest"
        ? restTransport(config.transport.baseUrl as string)
        : inProcessTransport((server as MainServer).adapter.receive);
  }

  const sender = transport
    ? new Sender(
        transport,
        {
          ackTimeoutMs: config.transport.ackTimeoutMs,
          retryCount: config.transport.retryCount,
          retryIntervalMs: config.transport.retryIntervalMs,
          host: hostname(),
        },
        logger,
      )
    : undefined;

  const plugins = sender
    ? await startPlugins(
        await loadPlugins(config.pluginDirectory, logger),
        {
          enabled: config.enabledPlugins,
          stateDirectory: config.stateDirectory,
          options: config.pluginOptions,
        },
        sender,
        logger,
      )
    : [];

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });

  await stopPlugins(plugins, SHUTDOWN_TIMEOUT_MS, logger);
  await sender?.close(SHUTDOWN_TIMEOUT_MS);
  await server?.stop();
  logger.info("stopped");
  await logger.close();
  releaseLock(lockPath);
}
