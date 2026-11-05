import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** 지원 플랫폼별 실행 파일과 Plugin, SHA-256 체크섬을 dist/release에 만듭니다. */

const TARGETS = ["linux-x64", "linux-arm64", "darwin-arm64"];

const release = join(import.meta.dir, "..", "dist", "release");

await rm(release, { recursive: true, force: true });
await mkdir(release, { recursive: true });

async function run(command: string[]): Promise<void> {
  const process = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  if ((await process.exited) !== 0) throw new Error(`failed: ${command.join(" ")}`);
}

await run([
  "bun",
  "build",
  "packages/plugin-opencode/src/index.ts",
  "--target=bun",
  "--format=esm",
  `--outfile=${join(release, "opencode.js")}`,
]);

for (const target of TARGETS) {
  await run([
    "bun",
    "build",
    "packages/app/src/main.ts",
    "--compile",
    `--target=bun-${target}`,
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    `--outfile=${join(release, `alm-${target}`)}`,
  ]);
}

const lines: string[] = [];
for (const name of (await readdir(release)).sort()) {
  const hash = createHash("sha256")
    .update(await Bun.file(join(release, name)).bytes())
    .digest("hex");
  lines.push(`${hash}  ${name}`);
}
await Bun.write(join(release, "SHA256SUMS"), `${lines.join("\n")}\n`);
