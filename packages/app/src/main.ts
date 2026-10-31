#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { type Config, defaultConfigPath, parseConfig } from "./config";
import { readAccessUrl } from "./connection";
import { run } from "./run";
import { installService, uninstallService } from "./service";

const VERSION = "0.1.0";

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
    case "url":
      console.log(readAccessUrl((await loadConfig(values.config)).stateDirectory));
      return;
    case "service": {
      if (action === "uninstall") {
        console.log(`removed ${uninstallService()}`);
        return;
      }
      if (action !== "install") break;
      const args = values.config ? ["run", "--config", values.config] : ["run"];
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
