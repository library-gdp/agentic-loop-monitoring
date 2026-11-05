import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const dist = join(import.meta.dir, "..", "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "plugins"), { recursive: true });

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
  `--outfile=${join(dist, "plugins", "opencode.js")}`,
]);

await run([
  "bun",
  "build",
  "packages/app/src/main.ts",
  "--compile",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  `--outfile=${join(dist, "alm")}`,
]);
