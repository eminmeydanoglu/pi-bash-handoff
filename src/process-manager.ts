import { spawn } from "node:child_process";
import { chmodSync, createWriteStream, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineRingBuffer, boundedTail } from "./output.ts";
import { DEFAULT_BACKGROUND_PROCESS_CONFIG, type BackgroundProcessConfig } from "./config.ts";
import type { CompletionEvent, ProcessKey, ProcessState, ProcessSummary, TaskRecord } from "./types.ts";

export interface ProcessManagerOptions extends Partial<BackgroundProcessConfig> {
    onCompletion?: (event: CompletionEvent) => void;
}

export type StartResult =
    | { kind: "foreground"; task: TaskRecord; output: string }
    | { kind: "background"; task: TaskRecord };

/** Session-local process owner. All spawned work follows this one lifecycle. */
export class ProcessManager {
    readonly yieldAfterMs: number;
    readonly sessionDir: string;
    private readonly config: BackgroundProcessConfig;
    private nextId = 1;
    private readonly active = new Map<string, TaskRecord>();
    private readonly recent: TaskRecord[] = [];
    private readonly listeners = new Set<() => void>();
    private stopping = false;

    constructor(private readonly options: ProcessManagerOptions = {}) {
        this.config = { ...DEFAULT_BACKGROUND_PROCESS_CONFIG, ...options };
        this.yieldAfterMs = this.config.yieldAfterMs;
        this.sessionDir = mkdtempSync(join(tmpdir(), "pi-background-processes-"));
        chmodSync(this.sessionDir, 0o700);
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async start(command: string, cwd: string, hardTimeoutMs?: number): Promise<StartResult> {
        if (!command.trim()) throw new Error("Command is empty.");
        const id = `p${this.nextId++}`;
        const logPath = join(this.sessionDir, `${id}.log`);
        const logStream = createWriteStream(logPath, { flags: "w", mode: 0o600 });
        const child = spawn("bash", ["-c", command], {
            cwd,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env },
        });
        if (!child.pid) throw new Error("Failed to spawn bash process.");
        const task: TaskRecord = {
            id, command, title: shortTitle(command), pid: child.pid, pgid: child.pid, child,
            state: "foreground", startedAt: Date.now(), stdinOpen: true, intentionalStop: false,
            completionDelivered: false, logPath, logStream,
            tail: new LineRingBuffer(this.config.memoryTailMaxLines, this.config.memoryTailMaxBytes), settled: false,
            hardTimedOut: false,
        };
        this.active.set(id, task);
        const write = (chunk: Buffer) => { logStream.write(chunk); task.tail.append(chunk); this.emit(); };
        child.stdout?.on("data", write);
        child.stderr?.on("data", write);
        child.stdin?.on("close", () => { task.stdinOpen = false; });
        child.stdin?.on("error", () => { task.stdinOpen = false; });
        task.completion = new Promise<void>((resolve) => {
            child.once("close", (code, signal) => { this.settle(task, code, signal); resolve(); });
            child.once("error", () => { this.settle(task, 1, null); resolve(); });
        });
        if (hardTimeoutMs && hardTimeoutMs > 0) {
            task.hardTimeout = setTimeout(() => {
                if (!task.settled) { task.hardTimedOut = true; void this.stopGroup(task); }
            }, hardTimeoutMs);
            task.hardTimeout.unref();
        }
        try {
            const winner = await Promise.race([
                task.completion.then(() => "settled" as const),
                timer(this.yieldAfterMs).then(() => "yield" as const),
            ]);
            // A just-settled child always receives the normal foreground result.
            if (winner === "settled" || task.settled) {
                return { kind: "foreground", task, output: boundedTail(task.tail, 400, 64 * 1024) || "(no output)" };
            }
            task.state = "background";
            task.yieldedAt = Date.now();
            this.emit();
            return { kind: "background", task };
        } finally { if (task.settled && task.hardTimeout) clearTimeout(task.hardTimeout); }
    }

    list(): ProcessSummary[] {
        const records = [...this.active.values(), ...this.recent.slice(-8).reverse()];
        return records.map((task) => this.summary(task));
    }

    get(id: string): TaskRecord | undefined { return this.active.get(id) ?? this.recent.find((item) => item.id === id); }

    peek(id: string, lines = this.config.peekDefaultLines): { task: TaskRecord; output: string } {
        const task = this.get(id);
        if (!task) throw new Error(`Unknown process: ${id}`);
        const count = Math.max(1, Math.min(this.config.peekMaxLines, Math.floor(lines)));
        return { task, output: boundedTail(task.tail, count, this.config.peekMaxBytes) || "(no output yet)" };
    }

    send(id: string, input?: string, key?: ProcessKey): void {
        const task = this.active.get(id);
        if (!task || task.settled) throw new Error(`Process ${id} is not running.`);
        if ((input === undefined) === (key === undefined)) throw new Error("Provide exactly one of input or key.");
        if (key === "ctrl-c") { this.signalGroup(task, "SIGINT"); return; }
        if (!task.stdinOpen || !task.child.stdin?.writable) throw new Error(`Process ${id} stdin is closed.`);
        if (key === "ctrl-d") { task.child.stdin.end(); task.stdinOpen = false; return; }
        const keys: Exclude<ProcessKey, "ctrl-c" | "ctrl-d">[] = ["enter", "esc", "tab", "backspace"];
        const codes: Record<(typeof keys)[number], string> = { enter: "\n", esc: "\u001b", tab: "\t", backspace: "\u007f" };
        task.child.stdin.write(input ?? codes[key as (typeof keys)[number]]);
    }

    async kill(id: string): Promise<TaskRecord> {
        const task = this.active.get(id);
        if (!task || task.settled) throw new Error(`Process ${id} is not running.`);
        task.intentionalStop = true; // Must precede signal: suppresses completion wake.
        await this.stopGroup(task);
        return task;
    }

    async shutdown(): Promise<void> {
        this.stopping = true;
        await Promise.all([...this.active.values()].filter((task) => !task.settled).map(async (task) => {
            task.intentionalStop = true;
            await this.stopGroup(task);
        }));
    }

    private async stopGroup(task: TaskRecord): Promise<void> {
        this.signalGroup(task, "SIGTERM");
        await Promise.race([task.completion ?? Promise.resolve(), timer(this.config.killGraceMs)]);
        if (!task.settled) this.signalGroup(task, "SIGKILL");
        await (task.completion ?? Promise.resolve());
    }

    private signalGroup(task: TaskRecord, signal: NodeJS.Signals): void {
        try { process.kill(process.platform === "win32" ? task.pid : -task.pgid, signal); }
        catch { try { process.kill(task.pid, signal); } catch { /* already gone */ } }
    }

    private settle(task: TaskRecord, code: number | null, signal: NodeJS.Signals | null): void {
        if (task.settled) return;
        task.settled = true;
        if (task.hardTimeout) clearTimeout(task.hardTimeout);
        task.endedAt = Date.now(); task.exitCode = code; task.signal = signal; task.stdinOpen = false;
        task.state = task.intentionalStop ? "killed" : task.hardTimedOut ? "timed_out" : code === 0 && !signal ? "exited" : "failed";
        task.logStream.end();
        this.active.delete(task.id);
        this.recent.push(task);
        if (this.recent.length > this.config.recentTaskLimit) this.recent.shift();
        if (task.yieldedAt && !task.intentionalStop && !this.stopping && !task.completionDelivered) {
            task.completionDelivered = true;
            this.options.onCompletion?.({ task, text: completionText(task, this.config) });
        }
        this.emit();
    }

    private summary(task: TaskRecord): ProcessSummary {
        return { id: task.id, state: task.state, title: task.title, pid: task.pid, pgid: task.pgid,
            elapsedMs: (task.endedAt ?? Date.now()) - task.startedAt, exitCode: task.exitCode };
    }
    private emit(): void { for (const listener of this.listeners) listener(); }
}

function timer(ms: number): Promise<void> { return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref(); }); }
function shortTitle(command: string): string { const text = command.replace(/\s+/g, " ").trim(); return text.length > 60 ? `${text.slice(0, 59)}…` : text; }
function duration(ms: number): string { return `${(ms / 1000).toFixed(1)}s`; }
export function completionText(task: TaskRecord, config: Pick<BackgroundProcessConfig, "completionLines" | "completionMaxBytes"> = DEFAULT_BACKGROUND_PROCESS_CONFIG): string {
    const tail = boundedTail(task.tail, config.completionLines, config.completionMaxBytes) || "(no output)";
    return [
        `Background process completed: ${task.id}`,
        `status: ${task.state}`,
        `exit_code: ${task.exitCode ?? "signal"}`,
        `duration: ${duration((task.endedAt ?? Date.now()) - task.startedAt)}`,
        "last output:", tail,
    ].join("\n");
}
