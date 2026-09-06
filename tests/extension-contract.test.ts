import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../src/index.ts";

test("registers only the canonical bash and flat process model tools", () => {
    const tools: Array<{ name: string; parameters: unknown; description?: string; promptGuidelines?: string[] }> = [];
    const commands: string[] = [];
    const handlers = new Map<string, Function>();
    register({
        registerTool: (tool: { name: string; parameters: unknown }) => tools.push(tool),
        registerCommand: (name: string) => commands.push(name),
        on: (event: string, handler: Function) => { handlers.set(event, handler); },
        sendMessage: () => {},
    } as never);
    assert.deepEqual(tools.map((tool) => tool.name), ["bash", "process"]);
    assert.deepEqual(commands, ["ps"]);
    const bash = tools[0]!.parameters as { properties: Record<string, unknown> };
    assert.deepEqual(Object.keys(bash.properties).sort(), ["command", "timeout"]);
    const process = tools[1]!.parameters as {
        type: string;
        properties: { action: { enum: string[] }; id: unknown; lines: unknown; input: unknown; key: { enum: string[] } };
        required: string[];
    };
    assert.equal(process.type, "object");
    assert.deepEqual(process.required, ["action"]);
    assert.deepEqual(process.properties.action.enum, ["list", "peek", "send", "kill"]);
    assert.deepEqual(process.properties.key.enum, ["enter", "ctrl-c", "ctrl-d", "esc", "tab", "backspace"]);
    assert.equal(JSON.stringify(process).includes("anyOf"), false);
    assert.equal(JSON.stringify(tools.map((tool) => tool.parameters)).match(/run_in_background|bg_|"const":"wait"|"const":"attach"/), null);
    assert.match(tools[1]!.description!, /pipe; it is not a PTY/i);
    assert.ok(tools[1]!.promptGuidelines?.some((line) => /Do not claim or demonstrate support for TTY/.test(line)));
    assert.ok(handlers.has("session_shutdown"));
});

test("process validates action-dependent fields after the flat provider schema", async () => {
    const tools: any[] = [];
    register({ registerTool: (tool: unknown) => tools.push(tool), registerCommand: () => {}, on: () => {}, sendMessage: () => {} } as never);
    const processTool = tools.find((tool) => tool.name === "process");
    const context = { cwd: process.cwd() };
    await assert.rejects(() => processTool.execute("call", {}, undefined, undefined, context), /requires action/);
    await assert.rejects(() => processTool.execute("call", { action: "peek" }, undefined, undefined, context), /requires id/);
    await assert.rejects(() => processTool.execute("call", { action: "send", id: "p1" }, undefined, undefined, context), /exactly one/);
    await assert.rejects(() => processTool.execute("call", { action: "send", id: "p1", input: "x", key: "enter" }, undefined, undefined, context), /exactly one/);
    const result = await processTool.execute("call", { action: "list" }, undefined, undefined, context);
    assert.match(result.content[0].text, /No tracked/);
});

test("extension completion uses queued followUp delivery exactly once", async () => {
    const tools: any[] = [];
    const messages: Array<{ message: unknown; options: unknown }> = [];
    register({
        registerTool: (tool: unknown) => tools.push(tool), registerCommand: () => {}, on: () => {},
        sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }),
    } as never);
    const realSetTimeout = globalThis.setTimeout;
    // Reduce only this test's extension foreground window; production defaults stay 10s.
    globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: any[]) =>
        realSetTimeout(fn, Math.min(ms ?? 0, 1), ...args)) as typeof setTimeout;
    try {
        const bash = tools.find((tool) => tool.name === "bash");
        const result = await bash.execute("call", { command: "sleep 0.03; echo wake" }, undefined, undefined, { cwd: process.cwd() });
        assert.match(result.content[0].text, /Background process p1/);
        await new Promise((resolve) => realSetTimeout(resolve, 60));
    } finally {
        globalThis.setTimeout = realSetTimeout;
    }
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0]!.options, { deliverAs: "followUp", triggerTurn: true });
    assert.match((messages[0]!.message as { content: string }).content, /Background process completed: p1/);
});
