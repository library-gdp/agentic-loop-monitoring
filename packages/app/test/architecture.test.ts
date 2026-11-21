/**
 * 모듈 경계를 확인합니다(docs/001.model/007.APPLICATION_ARCHITECTURE.md, docs/002.implementation/001.TECH_STACK.md).
 * Main Server의 모든 모듈은 Core에 의존하고 Core는 다른 모듈에 의존하지 않으며, Main Server에서는 Persistence만
 * SQLite를 다룹니다. Daemon과 Plugin은 Plugin API에만 의존합니다.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = join(import.meta.dir, "../..");

/** 패키지마다 의존해도 되는 workspace 패키지입니다. */
const ALLOWED: Record<string, readonly string[]> = {
    "plugin-api": [],
    core: ["@agentoscope/plugin-api"],
    persistence: ["@agentoscope/core"],
    "input-adapter": ["@agentoscope/core", "@agentoscope/plugin-api"],
    daemon: ["@agentoscope/plugin-api"],
    "plugin-opencode": ["@agentoscope/plugin-api"],
    app: [
        "@agentoscope/core",
        "@agentoscope/daemon",
        "@agentoscope/input-adapter",
        "@agentoscope/persistence",
        "@agentoscope/plugin-api",
    ],
};

function packageNames(): string[] {
    return Array.from(new Bun.Glob("*/package.json").scanSync({ cwd: PACKAGES }))
        .map((path) => path.split("/")[0] ?? "")
        .sort();
}

function sourceFiles(name: string): string[] {
    return Array.from(
        new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: join(PACKAGES, name) }),
    ).map((path) => join(PACKAGES, name, path));
}

function workspaceDependencies(name: string): string[] {
    const manifest = JSON.parse(readFileSync(join(PACKAGES, name, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
    };
    return Object.keys(manifest.dependencies ?? {})
        .filter((dependency) => dependency.startsWith("@agentoscope/"))
        .sort();
}

describe("module boundaries", () => {
    test("every package has a known place in the architecture", () => {
        expect(packageNames()).toEqual(Object.keys(ALLOWED).sort());
    });

    test("packages depend only on the packages the architecture allows", () => {
        for (const name of packageNames()) {
            expect({ name, dependencies: workspaceDependencies(name) }).toEqual({
                name,
                dependencies: [...(ALLOWED[name] ?? [])].sort(),
            });
        }
    });

    test("sources import only the workspace packages they declare", () => {
        for (const name of packageNames()) {
            const declared = new Set(workspaceDependencies(name));
            for (const file of sourceFiles(name)) {
                const text = readFileSync(file, "utf8");
                for (const match of text.matchAll(/from\s+"(@agentoscope\/[\w-]+)/g)) {
                    expect({
                        file,
                        imported: match[1],
                        declared: declared.has(match[1] ?? ""),
                    }).toEqual({ file, imported: match[1], declared: true });
                }
            }
        }
    });

    /** Main Server의 Persistence와, OpenCode의 SQLite DB를 읽는 OpenCode Plugin만 SQLite를 다룹니다. */
    const SQLITE_USERS = ["persistence", "plugin-opencode"];

    test("only Persistence and the OpenCode Plugin refer to SQLite", () => {
        for (const name of packageNames()) {
            for (const file of sourceFiles(name)) {
                const usesSqlite = readFileSync(file, "utf8").includes("bun:sqlite");
                expect({ file, usesSqlite }).toEqual({
                    file,
                    usesSqlite: SQLITE_USERS.includes(name) && usesSqlite,
                });
            }
        }
    });
});
