#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { version } from "../../../package.json";
import { type Config, defaultConfigPath, parseConfig } from "./config";
import { connectionPath, readAccessUrl } from "./connection";
import { run } from "./run";
import { installService, uninstallService } from "./service";

/** 릴리스 태그와 같은 루트 package.json의 version입니다. 빌드할 때 실행 파일에 들어갑니다. */
const VERSION = version;

const USAGE = `Usage: alm <command> [--config <path>]

Commands:
  run                  Daemon과 Main Server를 실행합니다.
  url                  Visualization 접속 URL을 출력합니다.
  service install      systemd user service나 launchd 파일을 만듭니다.
  service uninstall    만든 서비스 파일을 지웁니다.
  version              버전을 출력합니다.
`;

async function loadConfig(path: string | undefined): Promise<Config> {
  const resolved = path ?? defaultConfigPath(process.env);
  const file = Bun.file(resolved);
  if (path !== undefined && !(await file.exists())) {
    throw new Error(`config file not found: ${resolved}`);
  }
  return parseConfig((await file.exists()) ? await file.text() : "", process.env);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { config: { type: "string" } },
    allowPositionals: true,
  });
  const [command, action] = positionals;

  switch (command) {
    case "run":
      await run(await loadConfig(values.config));
      return;
    case "url": {
      const { stateDirectory } = await loadConfig(values.config);
      if (!existsSync(connectionPath(stateDirectory))) {
        throw new Error("alm is not running. Start it with `alm run`.");
      }
      console.log(readAccessUrl(stateDirectory));
      return;
    }
    case "service": {
      if (action === "uninstall") {
        console.log(`removed ${uninstallService()}`);
        return;
      }
      if (action !== "install") break;
      // 서비스는 다른 작업 디렉터리에서 시작하므로 설정 파일 경로를 절대 경로로 씁니다.
      const args = values.config ? ["run", "--config", resolve(values.config)] : ["run"];
      console.log(`wrote ${installService([process.execPath, ...args])}`);
      return;
    }
    case "version":
      console.log(VERSION);
      return;
  }
  console.error(USAGE);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
