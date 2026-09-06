import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadBackgroundProcessConfig } from "./config.ts";
import { ProcessManager } from "./process-manager.ts";
import { registerUi } from "./ui.ts";
import type { ProcessKey } from "./types.ts";

const bashParameters = Type.Object({
    command: Type.String({ description: "Shell command to run" }),
    timeout: Type.Optional(Type.Number({ description: "Hard total-runtime timeout in seconds" })),
});

/**
 * Keep this deliberately flat. CommandCode's GLM tool-call path did not
 * reliably populate a root `anyOf` discriminated union: it selected
 * `process`, but transmitted `{}` rather than the intended `{ action: ... }`.
 * A single object with enum fields is substantially easier for that provider
 * to serialize. Action-specific requirements are checked in execute().
 */
const processParameters = Type.Object({
    action: Type.String({
        enum: ["list", "peek", "send", "kill"],
        description: "Operation to perform: list, peek, send, or kill",
    }),
    id: Type.Optional(Type.String({ description: "Background process id (required for peek, send, and kill)" })),
    lines: Type.Optional(Type.Number({ description: "Tail lines for peek (1-100)" })),
    input: Type.Optional(Type.String({ description: "Text to send; provide exactly one of input or key for send" })),
    key: Type.Optional(Type.String({
        enum: ["enter", "ctrl-c", "ctrl-d", "esc", "tab", "backspace"],
        description: "Special key to send; provide exactly one of input or key for send",
    })),
});

type BashParams = { command: string; timeout?: number };
type ProcessParams = {
    action: "list" | "peek" | "send" | "kill";
    id?: string;
    lines?: number;
    input?: string;
    key?: ProcessKey;
};
type ToolContext = { cwd: string; ui?: unknown };
const text = (value: string): AgentToolResult<undefined> => ({ content: [{ type: "text", text: value }], details: undefined });

export default function registerBackgroundProcesses(pi: ExtensionAPI): void {
    const config = loadBackgroundProcessConfig(process.cwd());
    const manager = new ProcessManager({
        ...config,
        onCompletion: ({ task, text: content }) => pi.sendMessage({
            customType: "background-process-completion", content, display: true,
            details: { id: task.id, state: task.state, exitCode: task.exitCode },
        }, { deliverAs: "followUp", triggerTurn: true }),
    });
    const setUi = registerUi(pi, manager);
    const originalBash = createBashToolDefinition(process.cwd());
    pi.registerTool({
        ...originalBash,
        name: "bash",
        description: "Run a bash command. Commands that outlive the short foreground window automatically continue in the background and notify you exactly once when complete.",
        promptSnippet: "Run shell commands; long commands automatically become asynchronous dependencies.",
        promptGuidelines: [
            "Shell commands automatically yield to the background when they outlive the foreground window.",
            "Background processes notify you automatically when they finish. Treat them as asynchronous dependencies: never sleep, wait, or poll merely for completion.",
            "If useful independent work remains, continue it. If blocked only on a background process, end your turn; completion will wake you.",
            "Use process(list|peek|send|kill) only when you actually need to inspect or control a running process.",
            "A supplied bash timeout remains a hard total-runtime limit even after automatic background handoff.",
        ],
        parameters: bashParameters,
        async execute(_callId, params, _signal, _onUpdate, ctx) {
            const p = params as BashParams; const bashCtx = ctx as ToolContext;
            if (bashCtx.ui) setUi(bashCtx as never);
            const result = await manager.start(p.command, bashCtx.cwd, p.timeout ? p.timeout * 1000 : undefined);
            if (result.kind === "background") {
                return text(`Background process ${result.task.id} is still running (pid/pgid ${result.task.pid}/${result.task.pgid}; elapsed ${(Date.now() - result.task.startedAt) / 1000}s). Completion will arrive automatically.`);
            }
            if (result.task.state !== "exited") throw new Error(result.output || `Command ${result.task.state}.`);
            return text(result.output);
        },
    });
    pi.registerTool({
        name: "process", label: "Process", description: "Inspect or control an existing background process without waiting. Actions: list, peek, send, kill. V1 sends stdin through a pipe; it is not a PTY or full-screen terminal.",
        promptSnippet: "Inspect or control a background process. Examples: process({ action: \"list\" }); process({ action: \"peek\", id: \"p1\" }); process({ action: \"send\", id: \"p1\", input: \"hello\\n\" }); process({ action: \"kill\", id: \"p1\" }).",
        promptGuidelines: [
            "Always include action exactly as one of: list, peek, send, kill.",
            "For peek, send, and kill, include the process id such as p1.",
            "For send, include exactly one of input or key.",
            "Do not use shell jobs, ps, kill, polling, or background ampersands to manage tracked processes; use this tool.",
            "V1 is pipe-interactive only. Do not claim or demonstrate support for TTY/full-screen programs or password prompts such as ssh authentication, fzf, less, vim, or htop. Never send credentials.",
        ],
        parameters: processParameters,
        async execute(_callId, params, _signal, _onUpdate, ctx) {
            if ((ctx as ToolContext).ui) setUi(ctx as never);
            const p = validateProcessParams(params);
            if (p.action === "list") {
                const records = manager.list();
                return text(records.length ? records.map((item) => `${item.id}  ${item.state}  ${item.title}  pid/pgid=${item.pid}/${item.pgid}  elapsed=${Math.floor(item.elapsedMs / 1000)}s${item.exitCode !== undefined ? ` exit=${item.exitCode ?? "signal"}` : ""}`).join("\n") : "No tracked background processes.");
            }
            if (p.action === "peek") { const result = manager.peek(p.id!, p.lines); return text(`${result.task.id} ${result.task.state}\n${result.output}`); }
            if (p.action === "send") { manager.send(p.id!, p.input, p.key); return text(`Input accepted for ${p.id}.`); }
            const result = await manager.kill(p.id!); return text(`Process ${result.id} stopped; completion notification suppressed.`);
        },
    });
    pi.on("session_start", (_event, ctx) => { setUi(ctx as never); });
    pi.on("session_shutdown", async () => { await manager.shutdown(); });
}

function validateProcessParams(params: unknown): ProcessParams {
    if (!params || typeof params !== "object") throw new Error("process requires an object with action: list, peek, send, or kill.");
    const p = params as Record<string, unknown>;
    if (p.action !== "list" && p.action !== "peek" && p.action !== "send" && p.action !== "kill") {
        throw new Error("process requires action: list, peek, send, or kill.");
    }
    const result: ProcessParams = { action: p.action };
    if (p.id !== undefined) {
        if (typeof p.id !== "string" || !p.id.trim()) throw new Error("process id must be a non-empty string.");
        result.id = p.id;
    }
    if (p.lines !== undefined) {
        if (typeof p.lines !== "number" || !Number.isFinite(p.lines)) throw new Error("process lines must be a finite number.");
        result.lines = p.lines;
    }
    if (p.input !== undefined) {
        if (typeof p.input !== "string") throw new Error("process input must be a string.");
        result.input = p.input;
    }
    if (p.key !== undefined) {
        const keys: ProcessKey[] = ["enter", "ctrl-c", "ctrl-d", "esc", "tab", "backspace"];
        if (typeof p.key !== "string" || !keys.includes(p.key as ProcessKey)) throw new Error("process key is invalid.");
        result.key = p.key as ProcessKey;
    }
    if (result.action !== "list" && !result.id) throw new Error(`process action ${result.action} requires id.`);
    if (result.action === "send" && (result.input === undefined) === (result.key === undefined)) {
        throw new Error("process action send requires exactly one of input or key.");
    }
    return result;
}
