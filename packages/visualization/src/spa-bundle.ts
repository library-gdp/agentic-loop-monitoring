import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SpaBundle {
  readonly js: string;
  readonly css: string;
}

/**
 * SPA를 번들합니다. 매크로로 불러 번들 시점에 실행하므로 결과가 실행 파일에 문자열로 들어갑니다.
 * 매크로 안에서는 Bun.build를 부를 수 없어 bun build 명령을 씁니다.
 */
export function bundleSpa(): SpaBundle {
  const web = join(import.meta.dir, "..", "web");
  const result = Bun.spawnSync([
    process.execPath,
    "build",
    join(web, "main.tsx"),
    "--target=browser",
    "--format=esm",
    "--minify",
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return {
    js: result.stdout.toString(),
    css: readFileSync(join(web, "styles.css"), "utf8"),
  };
}
