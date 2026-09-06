import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { ProcessManager } from "../src/process-manager.ts";

const cwd = process.cwd();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function eventually(predicate: () => boolean, message: string): Promise<void> {
    for (let n = 0; n < 80; n++) { if (predicate()) return; await delay(10); }
    assert.fail(message);
}

test("quick command returns foreground and creates no completion event", async () => {
    const events: string[] = [];
    const manager = new ProcessManager({ yieldAfterMs: 100, onCompletion: ({ task }) => events.push(task.id) });
    const result = await manager.start("printf 'hello\\n'", cwd);
    assert.equal(result.kind, "foreground");
    assert.match(result.output, /hello/);
    await delay(30);
    assert.deepEqual(events, []);
    assert.equal(manager.list().some((item) => item.state === "background"), false);
});

test("a single spawned pid hands off and emits exactly one completion", async () => {
    const events: string[] = [];
    const manager = new ProcessManager({ yieldAfterMs: 20, onCompletion: ({ task }) => events.push(task.id) });
    const result = await manager.start("echo begin; sleep 0.08; echo done", cwd);
    assert.equal(result.kind, "background");
    const pid = result.task.pid;
    assert.equal(manager.get(result.task.id)?.pid, pid);
    await eventually(() => events.length === 1, "completion was not delivered");
    assert.deepEqual(events, [result.task.id]);
    assert.match(manager.peek(result.task.id).output, /begin[\s\S]*done/);
});

test("peek is tail-only and bounded by lines and bytes", async () => {
    const manager = new ProcessManager({ yieldAfterMs: 10 });
    const result = await manager.start("for i in $(seq 1 300); do echo line-$i; done; sleep 0.08", cwd);
    assert.equal(result.kind, "background");
    await delay(30);
    const output = manager.peek(result.task.id, 100).output;
    assert.ok(output.split("\n").length <= 101);
    assert.ok(Buffer.byteLength(output) <= 16 * 1024);
    assert.match(output, /line-300/);
    assert.doesNotMatch(output, /line-1\n/);
    await result.task.completion;
    assert.match(readFileSync(result.task.logPath, "utf8"), /line-1[\s\S]*line-300/);
    assert.equal(statSync(result.task.logPath).mode & 0o777, 0o600);
});

test("manager options apply project-configurable handoff and output bounds", async () => {
    const manager = new ProcessManager({
        yieldAfterMs: 10,
        peekDefaultLines: 2,
        peekMaxLines: 2,
        peekMaxBytes: 32,
        memoryTailMaxLines: 20,
        memoryTailMaxBytes: 128,
    });
    const result = await manager.start("echo alpha; echo bravo; echo charlie; sleep 0.04", cwd);
    assert.equal(result.kind, "background");
    await delay(20);
    const output = manager.peek(result.task.id).output;
    assert.ok(output.split("\n").length <= 2);
    assert.ok(Buffer.byteLength(output) <= 32);
    assert.match(output, /charlie/);
    await result.task.completion;
});

test("completion event has the strict tail bound", async () => {
    const events: string[] = [];
    const manager = new ProcessManager({ yieldAfterMs: 10, onCompletion: ({ text }) => events.push(text) });
    const result = await manager.start("for i in $(seq 1 80); do echo complete-$i; done; sleep 0.04", cwd);
    assert.equal(result.kind, "background");
    await eventually(() => events.length === 1, "completion was not delivered");
    const event = events[0]!;
    const tail = event.split("last output:\n")[1]!;
    assert.ok(tail.split("\n").length <= 15);
    assert.ok(Buffer.byteLength(tail) <= 8 * 1024);
    assert.match(tail, /complete-80/);
});

test("pipe stdin text settles naturally and reports completion", async () => {
    const events: string[] = [];
    const manager = new ProcessManager({ yieldAfterMs: 10, onCompletion: ({ task }) => events.push(task.id) });
    const result = await manager.start("read line; echo received:$line", cwd);
    assert.equal(result.kind, "background");
    manager.send(result.task.id, "hello\n");
    await eventually(() => events.length === 1, "stdin task did not complete");
    assert.match(manager.peek(result.task.id).output, /received:hello/);
});

test("intentional kill terminates the process group and suppresses completion", async () => {
    const events: string[] = [];
    const manager = new ProcessManager({ yieldAfterMs: 10, onCompletion: ({ task }) => events.push(task.id) });
    const result = await manager.start("sleep 10 & child=$!; echo child:$child; wait", cwd);
    assert.equal(result.kind, "background");
    await delay(20);
    const child = Number(manager.peek(result.task.id).output.match(/child:(\d+)/)?.[1]);
    assert.ok(child > 0);
    await manager.kill(result.task.id);
    await delay(30);
    assert.deepEqual(events, []);
    assert.equal(manager.get(result.task.id)?.state, "killed");
    assert.throws(() => process.kill(child, 0));
});

test("ctrl-c signals the group but still delivers its natural completion", async () => {
    const events: string[] = [];
    const manager = new ProcessManager({ yieldAfterMs: 10, onCompletion: ({ task }) => events.push(task.id) });
    const result = await manager.start("sleep 10", cwd);
    assert.equal(result.kind, "background");
    manager.send(result.task.id, undefined, "ctrl-c");
    await eventually(() => events.length === 1, "SIGINT completion was not delivered");
    assert.notEqual(manager.get(result.task.id)?.state, "killed");
});

test("hard timeout applies before and after background handoff", async () => {
    const foreground = new ProcessManager({ yieldAfterMs: 100 });
    const first = await foreground.start("sleep 1", cwd, 20);
    assert.equal(first.kind, "foreground");
    assert.equal(first.task.state, "timed_out");
    const events: string[] = [];
    const background = new ProcessManager({ yieldAfterMs: 10, onCompletion: ({ task }) => events.push(task.state) });
    const second = await background.start("sleep 1", cwd, 30);
    assert.equal(second.kind, "background");
    await eventually(() => events.length === 1, "background hard timeout was not delivered");
    assert.deepEqual(events, ["timed_out"]);
});

test("session shutdown kills active work without a completion wake", async () => {
    const events: string[] = [];
    const manager = new ProcessManager({ yieldAfterMs: 10, onCompletion: ({ task }) => events.push(task.id) });
    const result = await manager.start("sleep 10", cwd);
    assert.equal(result.kind, "background");
    await manager.shutdown();
    await delay(20);
    assert.deepEqual(events, []);
    assert.equal(manager.get(result.task.id)?.state, "killed");
});

test("yield boundary has foreground XOR completion ownership", async () => {
    for (let n = 0; n < 12; n++) {
        const events: string[] = [];
        const manager = new ProcessManager({ yieldAfterMs: 1, onCompletion: ({ task }) => events.push(task.id) });
        const result = await manager.start("true", cwd);
        await delay(15);
        assert.equal((result.kind === "foreground") === (events.length === 0), true);
    }
});

test("giant single line remains bounded", async () => {
    const manager = new ProcessManager({ yieldAfterMs: 10 });
    const result = await manager.start("head -c 300000 /dev/zero | tr '\\0' x; sleep 0.05", cwd);
    assert.equal(result.kind, "background");
    await delay(25);
    assert.ok(Buffer.byteLength(manager.peek(result.task.id, 100).output) <= 16 * 1024);
    await result.task.completion;
});
