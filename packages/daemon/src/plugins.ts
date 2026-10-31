import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type JsonObject,
  PLUGIN_API_VERSION,
  type Plugin,
  type PluginModule,
  type PluginRegistry,
} from "@alm/plugin-api";
import type { DaemonLogger } from "./logger";
import type { Sender } from "./sender";

const AGENT_ID = /^[a-z]+(-[a-z]+)*$/;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Plugin 디렉터리의 모듈을 불러와 Plugin Collection을 만듭니다. */
export async function loadPlugins(
  directory: string,
  logger: DaemonLogger,
): Promise<ReadonlyMap<string, Plugin>> {
  const collection = new Map<string, Plugin>();
  let open = false;
  const registry: PluginRegistry = {
    register(plugin) {
      if (!open) {
        logger.warn("ignored a plugin registered outside of register");
        return;
      }
      if (!isValid(plugin)) {
        logger.warn("rejected an invalid plugin");
        return;
      }
      if (collection.has(plugin.agent)) {
        logger.warn("rejected a duplicate plugin", { agent: plugin.agent });
        return;
      }
      collection.set(plugin.agent, plugin);
    },
  };

  let files: string[];
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith(".js")).sort();
  } catch (error) {
    logger.warn("cannot read the plugin directory", { directory, message: describe(error) });
    return collection;
  }

  for (const file of files) {
    const path = join(directory, file);
    try {
      const module = (await import(path)) as Partial<PluginModule>;
      if (module.apiVersion !== PLUGIN_API_VERSION || typeof module.register !== "function") {
        logger.warn("skipped an incompatible plugin module", {
          module: basename(path),
          apiVersion: String(module.apiVersion),
        });
        continue;
      }
      open = true;
      module.register(registry);
    } catch (error) {
      logger.error("failed to load a plugin module", {
        module: basename(path),
        message: describe(error),
      });
    } finally {
      open = false;
    }
  }
  return collection;
}

function isValid(plugin: Plugin): boolean {
  return (
    AGENT_ID.test(plugin.agent) &&
    typeof plugin.version === "string" &&
    plugin.version.length > 0 &&
    typeof plugin.start === "function" &&
    typeof plugin.stop === "function"
  );
}

export interface StartPluginsOptions {
  readonly enabled: readonly string[];
  readonly stateDirectory: string;
  readonly options: Readonly<Record<string, JsonObject>>;
}

/** 설정에서 활성화한 Plugin을 시작하고, 시작에 성공한 Plugin을 돌려줍니다. */
export async function startPlugins(
  collection: ReadonlyMap<string, Plugin>,
  settings: StartPluginsOptions,
  sender: Sender,
  logger: DaemonLogger,
): Promise<readonly Plugin[]> {
  const started: Plugin[] = [];
  for (const agent of settings.enabled) {
    const plugin = collection.get(agent);
    if (!plugin) {
      logger.warn("enabled plugin is not in the plugin directory", { agent });
      continue;
    }
    const scoped = logger.with({ plugin: agent });
    try {
      const stateDirectory = join(settings.stateDirectory, "plugins", agent);
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      await plugin.start({
        submit: (unit) => sender.submit(plugin.agent, plugin.version, unit),
        logger: scoped,
        stateDirectory,
        options: settings.options[agent] ?? {},
      });
      started.push(plugin);
      scoped.info("plugin started", { version: plugin.version });
    } catch (error) {
      scoped.error("failed to start a plugin", { message: describe(error) });
    }
  }
  return started;
}

export async function stopPlugins(
  plugins: readonly Plugin[],
  timeoutMs: number,
  logger: DaemonLogger,
): Promise<void> {
  await Promise.all(
    plugins.map(async (plugin) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          plugin.stop(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("plugin stop timed out")), timeoutMs);
          }),
        ]);
      } catch (error) {
        logger.error("failed to stop a plugin", {
          plugin: plugin.agent,
          message: describe(error),
        });
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}
