import type { ChildProcess } from "node:child_process";
import type { WriteStream } from "node:fs";
import type { LineRingBuffer } from "./output.ts";

export type ProcessState = "foreground" | "background" | "exited" | "failed" | "timed_out" | "killed";
export type ProcessKey = "enter" | "ctrl-c" | "ctrl-d" | "esc" | "tab" | "backspace";

export interface TaskRecord {
    id: string;
    command: string;
    title: string;
    pid: number;
    pgid: number;
    child: ChildProcess;
    state: ProcessState;
    startedAt: number;
    yieldedAt?: number;
    endedAt?: number;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    stdinOpen: boolean;
    intentionalStop: boolean;
    completionDelivered: boolean;
    logPath: string;
    logStream: WriteStream;
    tail: LineRingBuffer;
    settled: boolean;
    hardTimedOut: boolean;
    hardTimeout?: NodeJS.Timeout;
    completion?: Promise<void>;
}

export interface ProcessSummary {
    id: string;
    state: ProcessState;
    title: string;
    pid: number;
    pgid: number;
    elapsedMs: number;
    exitCode?: number | null;
}

export interface CompletionEvent {
    task: TaskRecord;
    text: string;
}
