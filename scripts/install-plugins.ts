import { chmod, copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "../packages/app/src/config";

/**
 * bun run build로 dist/plugins에 만든 Plugin을 Daemon의 Plugin 디렉터리에 설치합니다.
 * Plugin 디렉터리는 실행 파일과 같은 방식으로 설정에서 정합니다(docs/002.implementation/007.CLIENT_ADAPTER_DAEMON.md).
 *
 *   bun run install-plugins                       # dist/plugins의 Plugin을 모두 설치
 *   bun run install-plugins -- opencode           # 에이전트 id를 골라 설치
 *   bun run install-plugin:opencode               # Plugin별 스크립트(package.json)로 설치
 *   bun run install-plugins -- --config ./config.toml
 */

const built = join(import.meta.dir, "..", "dist", "plugins");

function fail(message: string): never {
    console.error(`install-plugins: ${message}`);
    process.exit(1);
}

const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: { config: { type: "string" } },
    allowPositionals: true,
});

let pluginDirectory: string;
try {
    const config = await loadConfig(values.config === undefined ? {} : { path: values.config });
    pluginDirectory = config.daemon.pluginDirectory;
} catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
}

let available: string[];
try {
    available = (await readdir(built))
        .filter((file) => file.endsWith(".js"))
        .map((file) => file.slice(0, -".js".length))
        .sort();
} catch {
    available = [];
}
if (available.length === 0) fail(`no built plugins in ${built}. Run "bun run build" first.`);

const agents = positionals.length === 0 ? available : positionals;
const missing = agents.filter((agent) => !available.includes(agent));
if (missing.length > 0) {
    fail(
        `no built plugin for ${missing.join(", ")} in ${built} (built: ${available.join(", ")}). Run "bun run build" first.`,
    );
}

await mkdir(pluginDirectory, { recursive: true, mode: 0o700 });
for (const agent of agents) {
    const target = join(pluginDirectory, `${agent}.js`);
    // Daemon은 .js 파일만 불러오므로, .js로 끝나지 않는 임시 파일에 복사한 뒤 이름을 바꿔 넣습니다.
    const temporary = join(pluginDirectory, `.${agent}.js.tmp`);
    try {
        await copyFile(join(built, `${agent}.js`), temporary);
        await chmod(temporary, 0o644);
        await rename(temporary, target);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
    console.log(`installed ${agent} -> ${target}`);
}
console.log("Restart agentoscope to load the installed plugins.");
