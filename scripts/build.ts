import { rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * 지금 플랫폼의 실행 파일을 dist/agentoscope에, 빌드한 Plugin을 dist/plugins에 만듭니다.
 * 지원 플랫폼별 릴리스 빌드는 release-build.ts가 맡습니다.
 */

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const outfile = join(dist, "agentoscope");
const plugins = join(dist, "plugins");

/** Plugin마다 패키지 디렉터리와 에이전트 id입니다. 빌드한 파일 이름은 에이전트 id입니다. */
const PLUGINS = [{ directory: "plugin-opencode", agent: "opencode" }];

await rm(outfile, { force: true });
await rm(plugins, { recursive: true, force: true });

async function run(command: string[]): Promise<void> {
    const child = Bun.spawn(command, { cwd: root, stdout: "inherit", stderr: "inherit" });
    if ((await child.exited) !== 0) throw new Error(`failed: ${command.join(" ")}`);
}

await run([
    process.execPath,
    "build",
    "packages/app/src/main.ts",
    "--compile",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    `--outfile=${outfile}`,
]);

for (const plugin of PLUGINS) {
    await run([
        process.execPath,
        "build",
        `packages/${plugin.directory}/src/index.ts`,
        "--target=bun",
        "--format=esm",
        `--outfile=${join(plugins, `${plugin.agent}.js`)}`,
    ]);
}
