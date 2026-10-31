import { homedir } from "node:os";
import { join } from "node:path";

export type Role = "all" | "daemon" | "server";

export interface Config {
  /** all은 한 프로세스, daemon과 server는 REST API Transport로 나누어 실행합니다. */
  readonly role: Role;
  readonly stateDirectory: string;
  readonly pluginDirectory: string;
  readonly dataFile: string;
  readonly enabledPlugins: readonly string[];
  readonly pluginOptions: Readonly<Record<string, Record<string, never>>>;
  readonly transport: {
    readonly kind: "in-process" | "rest";
    readonly baseUrl?: string;
    readonly ackTimeoutMs: number;
    readonly retryCount: number;
    readonly retryIntervalMs: number;
  };
  readonly storage: { readonly busyTimeoutMs: number };
  readonly visualization: { readonly port: number };
  readonly server: { readonly host: string; readonly port: number };
}

const APP = "agentic-loop-monitoring";

export function defaultConfigPath(env: NodeJS.ProcessEnv): string {
  const home = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(home, APP, "config.toml");
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a table`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function number(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (!allowed.includes(value as T)) throw new Error(`${name} must be ${allowed.join(" or ")}`);
  return value as T;
}

/** TOML 내용을 설정으로 바꿉니다. 없는 항목은 기본값입니다. */
export function parseConfig(text: string, env: NodeJS.ProcessEnv): Config {
  const raw = object(Bun.TOML.parse(text), "config");
  const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");

  const enabled = raw.enabled_plugins ?? ["opencode"];
  if (!Array.isArray(enabled) || !enabled.every((item) => typeof item === "string")) {
    throw new Error("enabled_plugins must be a list of agent ids");
  }

  const transport = object(raw.transport, "transport");
  const kind = oneOf(transport.kind, "transport.kind", ["in-process", "rest"], "in-process");
  const baseUrl = string(transport.base_url, "transport.base_url");
  const role = oneOf(raw.role, "role", ["all", "daemon", "server"], "all");
  if (role === "daemon" && kind !== "rest") {
    throw new Error('role "daemon" needs transport.kind = "rest"');
  }
  if (kind === "rest" && role !== "server" && !baseUrl) {
    throw new Error("transport.base_url is required for the rest transport");
  }

  const storage = object(raw.storage, "storage");
  const visualization = object(raw.visualization, "visualization");
  const server = object(raw.server, "server");

  return {
    role,
    stateDirectory: string(raw.state_directory, "state_directory") ?? join(stateHome, APP),
    pluginDirectory:
      string(raw.plugin_directory, "plugin_directory") ?? join(dataHome, APP, "plugins"),
    dataFile: string(raw.data_file, "data_file") ?? join(dataHome, APP, "data.db"),
    enabledPlugins: enabled,
    pluginOptions: object(raw.plugins, "plugins") as Config["pluginOptions"],
    transport: {
      kind,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ackTimeoutMs: number(transport.ack_timeout_ms, "transport.ack_timeout_ms", 10_000),
      retryCount: number(transport.retry_count, "transport.retry_count", 5),
      retryIntervalMs: number(transport.retry_interval_ms, "transport.retry_interval_ms", 500),
    },
    storage: { busyTimeoutMs: number(storage.busy_timeout_ms, "storage.busy_timeout_ms", 5_000) },
    visualization: { port: number(visualization.port, "visualization.port", 0) },
    server: {
      host: string(server.host, "server.host") ?? "127.0.0.1",
      port: number(server.port, "server.port", 7781),
    },
  };
}
