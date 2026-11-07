import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 저장소의 소스로 실행합니다. 설치한 Daemon과 상태가 섞이지 않도록 임시 디렉터리를 씁니다. */
const root = join(import.meta.dir, "..");
const home = await mkdtemp(join(tmpdir(), "alm-dev-"));
const plugins = join(home, "plugins");
await mkdir(plugins);

const built = Bun.spawnSync([
  "bun",
  "build",
  join(root, "packages/plugin-opencode/src/index.ts"),
  "--target=bun",
  "--format=esm",
  `--outfile=${join(plugins, "opencode.js")}`,
]);
if (built.exitCode !== 0) throw new Error(built.stderr.toString());

const config = join(home, "config.toml");
await Bun.write(
  config,
  `state_directory = ${JSON.stringify(join(home, "state"))}
plugin_directory = ${JSON.stringify(plugins)}
data_file = ${JSON.stringify(join(home, "data.db"))}
`,
);
console.log(`config: ${config}`);
console.log(`url: bun packages/app/src/main.ts url --config ${config}`);
const server = Bun.spawn(
  ["bun", join(root, "packages/app/src/main.ts"), "run", "--config", config],
  {
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.on("SIGINT", () => server.kill("SIGINT"));
process.exitCode = await server.exited;
