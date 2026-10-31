import { join } from "node:path";
import { PLUGIN_API_VERSION, type Plugin, type PluginRegistry } from "@alm/plugin-api";
import { version } from "../package.json";
import { Collector } from "./collector";
import { resolveDatabasePath } from "./database-path";
import { Trigger } from "./trigger";

function createPlugin(): Plugin {
  let trigger: Trigger | undefined;
  let collector: Collector | undefined;
  let stopped = false;

  return {
    agent: "opencode",
    version,

    async start(context) {
      const { database } = context.options;
      const path = resolveDatabasePath(
        typeof database === "string" ? database : undefined,
        process.env,
      );
      if (path.endsWith(":memory:")) throw new Error("cannot collect an in-memory database");
      stopped = false;
      const state = join(context.stateDirectory, "positions.json");
      const current = new Collector(path, state, context, () => stopped);
      collector = current;
      trigger = new Trigger(
        path,
        () => current.collect(),
        (error) => {
          context.logger.error("collection failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
      trigger.start();
      context.logger.info("collecting opencode sessions", { path });
    },

    async stop() {
      stopped = true;
      await trigger?.stop();
      collector?.close();
      trigger = undefined;
      collector = undefined;
    },
  };
}

export const apiVersion = PLUGIN_API_VERSION;

export function register(registry: PluginRegistry): void {
  registry.register(createPlugin());
}
