import { rm } from "node:fs/promises";
import { join } from "node:path";

/** 지금 플랫폼의 실행 파일을 dist/agentoscope에 만듭니다. 지원 플랫폼별 릴리스 빌드는 release-build.ts가 맡습니다. */

const root = join(import.meta.dir, "..");
const outfile = join(root, "dist", "agentoscope");

await rm(outfile, { force: true });

const build = Bun.spawn(
    [
        process.execPath,
        "build",
        "packages/app/src/main.ts",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        `--outfile=${outfile}`,
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if ((await build.exited) !== 0) throw new Error("failed to build the agentoscope executable");
