import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Focusable } from "@earendil-works/pi-tui";
import { boundedTail } from "./output.ts";
import type { ProcessManager } from "./process-manager.ts";

const WIDGET_KEY = "ultimate-background-processes";
type UiHost = { ui: { setWidget: (name: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) => void } };

/** Human-only widget and live `/ps` overlay. No model tool is registered here. */
export function registerUi(pi: ExtensionAPI, manager: ProcessManager): (ctx: UiHost) => void {
    let current: UiHost | undefined;
    const renderWidget = () => {
        if (!current) return;
        const active = manager.list().filter((item) => item.state === "background");
        if (active.length === 0) { current.ui.setWidget(WIDGET_KEY, undefined); return; }
        const lines = active.length <= 3
            ? active.map((item) => `■ ${item.id} ${item.title}  ${formatDuration(item.elapsedMs)}`)
            : [`■ ${active.length} background processes • /ps`];
        current.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
    };
    manager.subscribe(renderWidget);
    pi.registerCommand("ps", {
        description: "Open the human background-process viewer",
        handler: async (_args: string, ctx: ExtensionCommandContext) => {
            current = ctx;
            renderWidget();
            await ctx.ui.custom<void>(
                (tui, theme, _keybindings, done) => new ProcessOverlay(manager, theme, done, tui),
                { overlay: true, overlayOptions: { anchor: "center", width: 92, maxHeight: 28 } },
            );
        },
    });
    return (ctx: UiHost) => { current = ctx; renderWidget(); };
}

class ProcessOverlay implements Focusable {
    readonly width = 90;
    focused = false;
    private selected = 0;
    private detail = false;
    /** Number of lines above the live tail in the bounded in-memory log. */
    private scrollOffset = 0;
    private readonly unsubscribe: () => void;

    constructor(
        private readonly manager: ProcessManager,
        private readonly theme: Theme,
        private readonly done: (result: void) => void,
        private readonly tui: { requestRender: () => void },
    ) { this.unsubscribe = manager.subscribe(() => this.tui.requestRender()); }

    handleInput(data: string): void {
        const tasks = this.manager.list();
        if (matchesKey(data, "escape")) {
            if (this.detail) { this.detail = false; this.invalidate(); }
            else { this.unsubscribe(); this.done(); }
            return;
        }
        if (this.detail) {
            if (matchesKey(data, "up") || data === "k") this.scrollOffset += 1;
            else if (matchesKey(data, "down") || data === "j") this.scrollOffset = Math.max(0, this.scrollOffset - 1);
            else if (matchesKey(data, "pageUp")) this.scrollOffset += 12;
            else if (matchesKey(data, "pageDown")) this.scrollOffset = Math.max(0, this.scrollOffset - 12);
            else if (data === "g" || data === "G") this.scrollOffset = 0;
            else if (data === "x") { const task = tasks[this.selected]; if (task?.state === "background") void this.manager.kill(task.id); }
            this.invalidate();
            return;
        }
        if (matchesKey(data, "up") || data === "k") this.selected = Math.max(0, this.selected - 1);
        else if (matchesKey(data, "down") || data === "j") this.selected = Math.min(Math.max(0, tasks.length - 1), this.selected + 1);
        else if (matchesKey(data, "return")) { if (tasks.length) { this.detail = true; this.scrollOffset = 0; } }
        else if (data === "x") { const task = tasks[this.selected]; if (task?.state === "background") void this.manager.kill(task.id); }
        this.invalidate();
    }

    render(_availableWidth: number): string[] {
        const tasks = this.manager.list();
        if (this.selected >= tasks.length) this.selected = Math.max(0, tasks.length - 1);
        const inner = this.width - 2;
        const border = (text: string) => this.theme.fg("border", text);
        const pad = (text: string) => text + " ".repeat(Math.max(0, inner - visibleWidth(text)));
        const row = (text = "") => `${border("│")}${pad(text)}${border("│")}`;
        const lines = [border(`╭${"─".repeat(inner)}╮`)];
        if (!this.detail) {
            lines.push(row(` ${this.theme.fg("accent", "Background processes")}  ${this.theme.fg("dim", "Enter inspect • x kill • Esc close")}`));
            lines.push(row(` ${this.theme.fg("dim", "id     state       elapsed  title")}`));
            if (!tasks.length) lines.push(row(" No tracked processes"));
            for (let i = 0; i < tasks.length; i++) {
                const task = tasks[i]!;
                const marker = i === this.selected ? this.theme.fg("accent", "▶") : " ";
                const exit = task.exitCode !== undefined ? ` exit=${task.exitCode ?? "signal"}` : "";
                lines.push(row(` ${marker} ${task.id.padEnd(6)} ${task.state.padEnd(11)} ${formatDuration(task.elapsedMs).padStart(7)}  ${task.title}${exit}`));
            }
        } else {
            const summary = tasks[this.selected];
            const task = summary && this.manager.get(summary.id);
            if (!task) { this.detail = false; return this.render(_availableWidth); }
            const allOutput = boundedTail(task.tail, 400, 64 * 1024).split("\n");
            this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, allOutput.length - 1));
            const end = Math.max(0, allOutput.length - this.scrollOffset);
            const output = allOutput.slice(Math.max(0, end - 15), end);
            lines.push(row(` ${this.theme.fg("accent", `${task.id} process detail`)}  ${this.theme.fg("dim", "Esc back • x kill • G live tail")}`));
            lines.push(row(` state: ${task.state}    pid/pgid: ${task.pid}/${task.pgid}    elapsed: ${formatDuration((task.endedAt ?? Date.now()) - task.startedAt)}`));
            lines.push(row(` command: ${task.command}`));
            lines.push(row(` ${this.theme.fg("dim", "live log tail")}`));
            for (const line of output.slice(-15)) lines.push(row(` ${line}`));
        }
        lines.push(border(`╰${"─".repeat(inner)}╯`));
        return lines;
    }

    invalidate(): void { this.tui.requestRender(); }
    dispose(): void { this.unsubscribe(); }
}

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000); const minutes = Math.floor(seconds / 60);
    return minutes ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}
