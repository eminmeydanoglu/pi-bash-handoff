import { Buffer } from "node:buffer";

/** A bounded, line-oriented output tail. Raw bytes remain in the disk log. */
export class LineRingBuffer {
    private readonly lines: string[] = [];
    private pending = "";
    private bytes = 0;

    constructor(
        private readonly maxLines = 400,
        private readonly maxBytes = 128 * 1024,
    ) {}

    append(chunk: Buffer | string): void {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const parts = (this.pending + text).split(/\n/);
        this.pending = parts.pop() ?? "";
        for (const line of parts) this.push(line);
        // A no-newline flood must still be bounded in memory.
        if (Buffer.byteLength(this.pending) > this.maxBytes) {
            this.pending = tailBytes(this.pending, Math.floor(this.maxBytes / 2));
        }
    }

    tail(maxLines: number, maxBytes: number): string {
        const all = [...this.lines, ...(this.pending ? [this.pending] : [])];
        return tailBytes(all.slice(-maxLines).join("\n"), maxBytes);
    }

    private push(line: string): void {
        this.lines.push(line);
        this.bytes += Buffer.byteLength(line) + 1;
        while (this.lines.length > this.maxLines || this.bytes > this.maxBytes) {
            const old = this.lines.shift();
            if (old === undefined) break;
            this.bytes -= Buffer.byteLength(old) + 1;
        }
    }
}

export function tailBytes(text: string, maxBytes: number): string {
    const bytes = Buffer.from(text);
    if (bytes.length <= maxBytes) return text;
    const prefix = "...[truncated]\n";
    return prefix + bytes.subarray(Math.max(0, bytes.length - maxBytes + Buffer.byteLength(prefix))).toString("utf8");
}

/** Safe model/TUI rendering only; the disk log is intentionally untouched. */
export function sanitizeOutput(text: string): string {
    return text
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
        .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function boundedTail(tail: LineRingBuffer, lines: number, bytes: number): string {
    return sanitizeOutput(tailBytes(tail.tail(lines, bytes), bytes));
}
