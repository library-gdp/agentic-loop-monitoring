/**
 * Plugin 디렉터리의 빌드한 Plugin을 불러와 Plugin Collection에 등록합니다.
 * docs/002.implementation/004.PLUGIN_GUIDE.md의 "Daemon이 Plugin을 불러오는 방식"과
 * 005.PLUGIN_INTERFACE.md를 따릅니다.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGIN_API_VERSION, type Plugin, type PluginRegistry } from "@agentoscope/plugin-api";
import { errorMessage, type Logger } from "./logger";

/** 에이전트 id 형식입니다. 소문자와 하이픈으로 이루어집니다. */
const AGENT_ID = /^[a-z]+(?:-[a-z]+)*$/;

/** 에이전트 id로 Plugin을 찾는 Plugin Collection입니다. 등록을 닫은 뒤에는 바뀌지 않습니다. */
export type PluginCollection = ReadonlyMap<string, Plugin>;

/** Plugin을 등록하려는 값이 Plugin의 형식에 맞지 않으면 그 이유를, 맞으면 undefined를 돌려줍니다. */
function invalidPlugin(plugin: unknown): string | undefined {
    if (typeof plugin !== "object" || plugin === null) return "the plugin is not an object";
    const { agent, version, start, stop } = plugin as Record<string, unknown>;
    if (typeof agent !== "string" || !AGENT_ID.test(agent)) {
        return "agent must be lowercase letters and hyphens";
    }
    if (typeof version !== "string" || version === "") return "version must be a non-empty string";
    if (typeof start !== "function" || typeof stop !== "function") {
        return "start and stop must be functions";
    }
    return undefined;
}

/**
 * 모듈 하나의 register를 불러 Plugin을 collection에 등록합니다. register가 끝나면 그 registry로는 더 등록할 수 없습니다.
 * 실패하면 로그를 남기고 그 모듈을 건너뜁니다.
 */
export function registerModule(
    module: unknown,
    file: string,
    collection: Map<string, Plugin>,
    logger: Logger,
): void {
    const { apiVersion, register } = (module ?? {}) as Record<string, unknown>;
    if (apiVersion !== PLUGIN_API_VERSION) {
        logger.error("skipped a plugin built for another plugin API version", {
            file,
            apiVersion: typeof apiVersion === "number" ? apiVersion : null,
            supported: PLUGIN_API_VERSION,
        });
        return;
    }
    if (typeof register !== "function") {
        logger.error("skipped a plugin module without a register function", { file });
        return;
    }
    let open = true;
    const registry: PluginRegistry = {
        register(plugin) {
            if (!open) {
                logger.error("rejected a plugin registered after register returned", { file });
                return;
            }
            const invalid = invalidPlugin(plugin);
            if (invalid !== undefined) {
                logger.error("rejected an invalid plugin", { file, reason: invalid });
                return;
            }
            const existing = collection.get(plugin.agent);
            if (existing !== undefined) {
                logger.error("rejected a plugin for an agent that already has one", {
                    file,
                    agent: plugin.agent,
                    version: plugin.version,
                    registered: existing.version,
                });
                return;
            }
            collection.set(plugin.agent, plugin);
            logger.info("registered a plugin", {
                file,
                agent: plugin.agent,
                version: plugin.version,
            });
        },
    };
    try {
        register(registry);
    } catch (error) {
        logger.error("a plugin module failed to register", { file, message: errorMessage(error) });
    } finally {
        open = false;
    }
}

/**
 * Plugin 디렉터리 바로 아래의 .js 파일을 이름 순서대로 불러와 등록합니다.
 * 디렉터리가 없거나 모듈을 불러오지 못해도 로그만 남기고, 불러온 Plugin으로 Collection을 만듭니다.
 */
export async function loadPlugins(directory: string, logger: Logger): Promise<PluginCollection> {
    const collection = new Map<string, Plugin>();
    let files: string[];
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        files = entries
            .filter(
                (entry) => entry.name.endsWith(".js") && (entry.isFile() || entry.isSymbolicLink()),
            )
            .map((entry) => entry.name)
            .sort();
    } catch (error) {
        logger.warn("cannot read the plugin directory", {
            directory,
            message: errorMessage(error),
        });
        return collection;
    }
    for (const name of files) {
        const file = join(directory, name);
        let module: unknown;
        try {
            module = await import(pathToFileURL(file).href);
        } catch (error) {
            logger.error("cannot load a plugin module", { file, message: errorMessage(error) });
            continue;
        }
        registerModule(module, file, collection, logger);
    }
    return collection;
}
