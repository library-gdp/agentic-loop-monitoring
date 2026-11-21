/**
 * OpenCode Plugin 모듈입니다. Daemon은 빌드한 이 모듈을 불러와 register를 부릅니다
 * (docs/002.implementation/005.PLUGIN_INTERFACE.md). 모듈을 불러오거나 register를 부르는 것만으로는 아무 일도 하지 않습니다.
 */

import { PLUGIN_API_VERSION, type PluginRegistry } from "@agentoscope/plugin-api";
import { createOpenCodePlugin } from "./plugin";

export const apiVersion = PLUGIN_API_VERSION;

export function register(registry: PluginRegistry): void {
    registry.register(createOpenCodePlugin());
}
