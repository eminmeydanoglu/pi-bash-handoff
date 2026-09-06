import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BACKGROUND_PROCESS_CONFIG, loadBackgroundProcessConfig, validateBackgroundProcessConfig } from "../src/config.ts";
import register from "../src/index.ts";

test("missing project config preserves the documented defaults", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-background-config-"));
    assert.deepEqual(loadBackgroundProcessConfig(cwd), DEFAULT_BACKGROUND_PROCESS_CONFIG);
});

test("project config overrides only explicit lifecycle settings", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-background-config-"));
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "background-processes.json"), JSON.stringify({ yieldAfterMs: 2_500, peekDefaultLines: 20, peekMaxLines: 25, completionLines: 7 }));
    const config = loadBackgroundProcessConfig(cwd);
    assert.equal(config.yieldAfterMs, 2_500);
    assert.equal(config.peekMaxLines, 25);
    assert.equal(config.completionLines, 7);
    assert.equal(config.peekDefaultLines, 20);
});

test("config rejects typos, non-integers, unsafe ranges, and inconsistent peek limits", () => {
    assert.throws(() => validateBackgroundProcessConfig({ yieldAfterMS: 1_000 }), /unknown setting/);
    assert.throws(() => validateBackgroundProcessConfig({ yieldAfterMs: 1.5 }), /must be an integer/);
    assert.throws(() => validateBackgroundProcessConfig({ completionMaxBytes: 12 }), /between 256/);
    assert.throws(() => validateBackgroundProcessConfig({ peekDefaultLines: 90, peekMaxLines: 20 }), /must not exceed/);
});

test("extension reads project config before it creates the bash process manager", async () => {
    const originalCwd = process.cwd();
    const cwd = mkdtempSync(join(tmpdir(), "pi-background-config-"));
    const handlers = new Map<string, Function>();
    const tools: any[] = [];
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "background-processes.json"), JSON.stringify({ yieldAfterMs: 1 }));
    process.chdir(cwd);
    try {
        register({
            registerTool: (tool: unknown) => tools.push(tool), registerCommand: () => {},
            on: (event: string, handler: Function) => handlers.set(event, handler), sendMessage: () => {},
        } as never);
        const bash = tools.find((tool) => tool.name === "bash");
        const result = await bash.execute("call", { command: "sleep 0.03; echo configured" }, undefined, undefined, { cwd });
        assert.match(result.content[0].text, /Background process p1/);
        await handlers.get("session_shutdown")!({}, {});
    } finally {
        process.chdir(originalCwd);
    }
});
