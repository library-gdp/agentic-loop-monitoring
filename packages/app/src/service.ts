import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LABEL = "agentic-loop-monitoring";
/** 측정한 RSS(대기 약 33 MB, 조회 뒤 약 38 MB)에 전송 대기열과 큰 input 조회를 위한 여유를 더한 값입니다. */
const MEMORY_MAX = "256M";

export function systemdUnit(command: readonly string[]): string {
  return `[Unit]
Description=Agentic Loop Monitoring

[Service]
ExecStart=${command.join(" ")}
Restart=on-failure
RestartSec=5
MemoryMax=${MEMORY_MAX}

[Install]
WantedBy=default.target
`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function launchdPlist(command: readonly string[]): string {
  const args = command.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
</dict>
</plist>
`;
}

function servicePath(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  }
  if (platform === "linux") {
    return join(homedir(), ".config", "systemd", "user", `${LABEL}.service`);
  }
  throw new Error(`unsupported platform: ${platform}`);
}

/** 서비스 파일을 만들고 그 경로를 돌려줍니다. 서비스를 켜는 일은 사용자가 합니다. */
export function installService(command: readonly string[]): string {
  const path = servicePath(process.platform);
  mkdirSync(dirname(path), { recursive: true });
  const content = process.platform === "darwin" ? launchdPlist(command) : systemdUnit(command);
  writeFileSync(path, content);
  return path;
}

export function uninstallService(): string {
  const path = servicePath(process.platform);
  rmSync(path, { force: true });
  return path;
}
