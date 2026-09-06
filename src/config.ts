import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Project-local knobs for the background-process extension. */
export interface BackgroundProcessConfig {
    /** Foreground time before a still-running bash command is handed off. */
    yieldAfterMs: number;
    /** Time to wait after SIGTERM before escalating an intentional stop to SIGKILL. */
    killGraceMs: number;
    /** Default and maximum line counts exposed by process.peek. */
    peekDefaultLines: number;
    peekMaxLines: number;
    /** Maximum rendered bytes exposed by process.peek. */
    peekMaxBytes: number;
    /** Bounded completion-event output. */
    completionLines: number;
    completionMaxBytes: number;
    /** Settled metadata records retained for process.list and /ps. */
    recentTaskLimit: number;
    /** Bounded in-memory tail; the owner-only disk log remains complete. */
    memoryTailMaxLines: number;
    memoryTailMaxBytes: number;
}

export const DEFAULT_BACKGROUND_PROCESS_CONFIG: Readonly<BackgroundProcessConfig> = Object.freeze({
    yieldAfterMs: 10_000,
    killGraceMs: 1_000,
    peekDefaultLines: 80,
    peekMaxLines: 100,
    peekMaxBytes: 16 * 1024,
    completionLines: 15,
    completionMaxBytes: 8 * 1024,
    recentTaskLimit: 32,
    memoryTailMaxLines: 400,
    memoryTailMaxBytes: 128 * 1024,
});

export function backgroundProcessConfigPath(cwd: string): string {
    return join(cwd, ".pi", "background-processes.json");
}

/**
 * Read only trusted, project-local configuration. A missing file deliberately
 * preserves all defaults; malformed or unknown configuration fails fast rather
 * than silently changing process lifecycle behavior.
 */
export function loadBackgroundProcessConfig(cwd: string): BackgroundProcessConfig {
    const path = backgroundProcessConfigPath(cwd);
    if (!existsSync(path)) return { ...DEFAULT_BACKGROUND_PROCESS_CONFIG };
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { throw new Error(`Invalid background-process config at ${path}: ${(error as Error).message}`); }
    return validateBackgroundProcessConfig(raw, path);
}

export function validateBackgroundProcessConfig(raw: unknown, source = "config"): BackgroundProcessConfig {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${source} must contain a JSON object.`);
    const values = raw as Record<string, unknown>;
    const allowed = Object.keys(DEFAULT_BACKGROUND_PROCESS_CONFIG);
    for (const key of Object.keys(values)) if (!allowed.includes(key)) throw new Error(`${source} has unknown setting: ${key}.`);
    const config = { ...DEFAULT_BACKGROUND_PROCESS_CONFIG } as BackgroundProcessConfig;
    for (const key of allowed as Array<keyof BackgroundProcessConfig>) {
        if (values[key] === undefined) continue;
        const value = values[key];
        if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${source}.${key} must be an integer.`);
        config[key] = value;
    }
    assertRange(config.yieldAfterMs, 1, 600_000, `${source}.yieldAfterMs`);
    assertRange(config.killGraceMs, 0, 60_000, `${source}.killGraceMs`);
    assertRange(config.peekDefaultLines, 1, 10_000, `${source}.peekDefaultLines`);
    assertRange(config.peekMaxLines, 1, 10_000, `${source}.peekMaxLines`);
    assertRange(config.peekMaxBytes, 256, 16 * 1024 * 1024, `${source}.peekMaxBytes`);
    assertRange(config.completionLines, 1, 1_000, `${source}.completionLines`);
    assertRange(config.completionMaxBytes, 256, 16 * 1024 * 1024, `${source}.completionMaxBytes`);
    assertRange(config.recentTaskLimit, 1, 1_000, `${source}.recentTaskLimit`);
    assertRange(config.memoryTailMaxLines, 1, 100_000, `${source}.memoryTailMaxLines`);
    assertRange(config.memoryTailMaxBytes, 1_024, 64 * 1024 * 1024, `${source}.memoryTailMaxBytes`);
    if (config.peekDefaultLines > config.peekMaxLines) throw new Error(`${source}.peekDefaultLines must not exceed peekMaxLines.`);
    return config;
}

function assertRange(value: number, min: number, max: number, name: string): void {
    if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}.`);
}
