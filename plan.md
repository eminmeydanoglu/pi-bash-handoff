# execution_plan.md — Minimal Pi Background Process Extension

## 0. Goal

Build a **small Pi extension** whose mental model is exactly:

```text
Agent:
  bash(...)
  process(list | peek | send | kill)

Harness / extension:
  automatic foreground -> background handoff
  full logging to disk
  exactly-once completion event
  automatic wake when completion matters

Human:
  compact running-task widget
  /ps
  live log viewer
```

The fundamental rule is:

> A background process is an independent dependency that emits a completion event. It is **not** something the agent waits on or polls.

The model must never need `bg_start`, `bg_wait`, `bg_status`, `bg_logs`, `jobs`, `attach`, or a polling loop.

---

# 1. Decision

## 1.1 No existing package matches the full contract

The ecosystem currently splits into three families:

1. **Correct auto-yield Bash semantics** — e.g. `@richardgill/pi-background-bash`, `@tian.zuo/pi-background-terminals`, `pi-bg-tasks`.
2. **Good process control / stdin / PTY** — e.g. `@99percentpeople/pi-background-tasks`, `@aliou/pi-processes`, `pi-unified-exec`.
3. **Good human dashboards / live terminal UX** — e.g. Tian, `@ifi/pi-background-tasks`, 99percent, tmux-based packages.

No package combines all of these while keeping the model surface to exactly `bash` + one tiny `process` tool and preserving the “never wait/poll” rule.

## 1.2 Recommended implementation strategy

### Fork base: `pi-bg-tasks`

Use the currently published MIT package `pi-bg-tasks` as the implementation base **after verifying that the repository/source commit matches the published 0.1.x package**.

Why this base:

- MIT licensed.
- Explicitly designed as a **zero-dependency**, simplified background-task core.
- Already overrides `bash`.
- Already supports foreground execution that can become background work.
- Already has process-group termination and completion notifications.
- Already has a small status UI and a much smaller conceptual footprint than Patty/tmux/workflow packages.
- Its current multiple helper tools are easy to collapse into one `process` tool.

Before editing:

```bash
npm view pi-bg-tasks version repository homepage license
npm pack pi-bg-tasks
```

Verify:

- license is MIT;
- repository URL corresponds to the source in the tarball;
- current source still has the architecture described by the package docs;
- there is no hidden dependency on a larger framework.

Pin the exact source commit/tag used for the fork in `UPSTREAM.md`.

### Do NOT use Richard's repository as the distributable fork base unless licensing is clarified

`@richardgill/pi-background-bash` is technically the closest conceptual implementation, but its published package metadata currently reports no declared license and the repository root does not expose a clear LICENSE file in the inspected tree.

Use it as a **design reference only** unless the author explicitly licenses the relevant code.

Its useful design ideas are:

- same-process foreground -> background handoff;
- detached POSIX process groups;
- combined uncapped disk log;
- minimal `list | peek | kill` process helper;
- intentional kill suppresses completion wake;
- background completion uses a follow-up turn rather than polling.

Do not copy source until licensing is explicit.

### Main UX/reference donor: `@tian.zuo/pi-background-terminals`

MIT licensed.

Use as the reference for:

- canonical single `bash` tool;
- initial yield window;
- race-safe exactly-once ownership between foreground result and background completion;
- `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` semantics;
- completion batching if several tasks settle together;
- compact running widget;
- `/ps` list/detail viewer;
- disk-backed full logs with bounded model-facing output;
- strict separation between model output and human log inspection.

**Do not import its Effect v4 runtime.** Reimplement the small relevant behavior in ordinary TypeScript so the new package stays zero-runtime-dependency.

### Optional dashboard reference: `@ifi/pi-background-tasks`

MIT licensed and small. Use only as a UI/reference donor if its dashboard implementation is simpler to transplant than Tian's.

### PTY donor only if Phase 2 becomes necessary: `@99percentpeople/pi-background-tasks`

MIT licensed.

It already solves:

- `node-pty` lifecycle;
- attach/detach;
- keyboard forwarding;
- terminal key parsing;
- resize/focus/mouse forwarding;
- detached terminal replay.

Do **not** use it as the v1 base. Its model API (`bg_start`, `bg_wait`, `bg_status`, `bg_logs`, `bg_send`, `bg_kill`) is the opposite of the desired minimal contract, and adding PTY support introduces a native dependency plus terminal-emulation complexity.

---

# 2. Non-negotiable product contract

## 2.1 The only model-facing tools

Exactly:

```text
bash
process
```

No aliases such as:

```text
bg_start
bg_wait
bg_status
bg_logs
bg_send
bg_kill
jobs
bash_bg
terminal_log_read
write_stdin
```

Human slash commands do **not** count as model tools.

## 2.2 `bash` behavior

Keep the schema as close to Pi's ordinary Bash schema as possible.

Recommended model-visible schema:

```ts
type BashInput = {
  command: string;
  timeout?: number; // hard total-runtime timeout, NOT the yield threshold
};
```

Do not expose:

```text
background
run_in_background
timeoutAction
yield_time_ms
```

The entire point is that the **harness**, not the model, decides when a process has become asynchronous.

The yield threshold is extension configuration, not a tool argument.

Recommended default:

```text
yieldAfterMs = 10_000
```

Make it configurable, but do not make the model choose it per command.

### Bash execution algorithm

1. Spawn the command immediately.
2. Give it its own POSIX process group (`detached: true` on Linux/macOS).
3. Keep stdin writable.
4. Pipe stdout/stderr.
5. Write all output to the full disk log from byte zero.
6. Race:
   - natural process completion;
   - `yieldAfterMs`.
7. If the process completes first:
   - return a normal foreground Bash result;
   - do **not** create a background-completion message.
8. If the yield timer wins:
   - mark the same process as `background`;
   - do not restart it;
   - return immediately with a tiny result containing only task id, pid/pgid, elapsed time, and the fact that completion will arrive automatically.
9. Keep listeners alive in the process manager.
10. When the process later settles, emit exactly one completion event.

Hard `timeout` is independent:

- if supplied, it caps **total** runtime whether the task is foreground or background;
- timeout kills the process group;
- if timeout happens after handoff, it is a background failure and should wake the model once;
- if timeout happens before handoff, return a foreground Bash error.

## 2.3 `process` tool

One discriminated-union tool:

```ts
type ProcessInput =
  | { action: "list" }
  | { action: "peek"; id: string; lines?: number }
  | { action: "send"; id: string; input?: string; key?: ProcessKey }
  | { action: "kill"; id: string };

type ProcessKey =
  | "enter"
  | "ctrl-c"
  | "ctrl-d"
  | "esc"
  | "tab"
  | "backspace";
```

Do not add `wait`.

Do not add `status`; `list` already carries status.

Do not add `logs`; `peek` is the only bounded model log surface.

### `process.list`

Return active background processes and optionally a very small number of recently completed records.

Each line/record should contain only:

```text
id
state
short title / shortened command
pid or pgid
elapsed time
exit code if already settled
```

Never return log contents from `list`.

### `process.peek`

Default:

```text
80 lines
```

Clamp:

```text
1..100 lines
```

Also enforce a byte cap so one pathological line cannot consume the context window:

```text
peekMaxBytes = 16 KiB
```

Return the **tail**, not head+tail.

Never expose an option to read the complete log through this tool.

### `process.send`

V1 is **pipe-interactive**, not PTY-interactive.

Implementation:

- normal `input` -> `child.stdin.write(input)`;
- `enter` -> write `\n`;
- `ctrl-d` -> close stdin (`child.stdin.end()`);
- `ctrl-c` -> send `SIGINT` to the entire process group, because writing byte `0x03` to a non-TTY pipe does not reliably reproduce terminal Ctrl-C semantics;
- `esc`, `tab`, `backspace` -> write corresponding control byte.

Require exactly one of `input` or `key`.

Return immediately after the write/signal is accepted. Never wait for resulting output.

If stdin is already closed or the process has exited, return a compact error.

### `process.kill`

- SIGTERM process group.
- short grace period.
- SIGKILL process group if needed.
- flush log stream.
- mark as intentional termination.
- **suppress automatic model completion wake** for this task.

The tool call itself is already the acknowledgement.

---

# 3. Completion-event semantics

This is the most important part of the implementation.

## 3.1 Exactly once

Every background process has a state flag/token such as:

```ts
completionOwner: "foreground" | "background" | "none"
completionDelivered: boolean
```

The foreground/yield race must atomically decide who owns final delivery.

Important boundary case:

```text
process exits at almost exactly yieldAfterMs
```

There must never be both:

- a foreground final Bash result, and
- a background completion event.

And never neither.

## 3.2 Correct Pi wake API

Use:

```ts
pi.sendMessage(message, {
  deliverAs: "followUp",
  triggerTurn: true,
});
```

This is mandatory.

Why:

- if the agent is idle, the completion starts a new turn;
- if the agent is still working, the message queues until the current work settles;
- it does not steer/interject into the current reasoning/tool batch.

Do not use `deliverAs: "steer"` for normal completion.

Do not implement polling.

## 3.3 Completion payload

The model receives only a compact event.

Recommended format:

```text
Background process completed: p3
status: exited
exit_code: 0
duration: 38.2s
last output:
<last 15 lines, max 8 KiB>
```

Defaults:

```text
completionLines = 15
completionMaxBytes = 8 KiB
```

No complete log.

Prefer not to expose the disk path in normal model output. The human UI can know it. The model should use `process.peek` when it deliberately needs a little more context.

## 3.4 Multiple completions

Nice-to-have, not a blocker:

If several tasks settle within roughly 50–150 ms, batch them into one follow-up message.

Keep this implementation tiny. Do not add a scheduler/framework.

If batching complicates correctness, ship exactly-once individual follow-ups first.

---

# 4. Agent behavior contract / prompt text

Inject a short system/tool guidance block, approximately:

```text
Shell commands automatically yield to the background when they outlive the foreground window.
Background processes notify you automatically when they finish.
Treat them as asynchronous dependencies: never sleep, wait, or poll merely for completion.
If useful independent work remains, continue it. If you are blocked only on a background process, end your turn; completion will wake you.
Use process(list|peek|send|kill) only when you actually need to inspect or control a running process.
```

Do not teach the model any `bg_*` vocabulary.

Do not encourage repeated `process.list` or `process.peek` calls.

---

# 5. Process manager

## 5.1 Minimal task record

```ts
interface TaskRecord {
  id: string;
  command: string;
  title: string;

  pid: number;
  pgid: number;
  child: ChildProcess;

  state: "foreground" | "background" | "exited" | "failed" | "timed_out" | "killed";

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

  // bounded in-memory tail only
  tail: LineRingBuffer;
}
```

Do not invent a workflow DAG, dependency graph, scheduler, worker queue, or database.

## 5.2 IDs

Use short stable session-local ids:

```text
p1
p2
p3
```

Do not force the model to use PGIDs as identity.

Expose PID/PGID as metadata only.

## 5.3 Lifecycle

Session-scoped only for v1.

On Pi `session_shutdown` / reload / quit:

- terminate all active process groups;
- flush logs;
- do not send completion messages;
- then dispose manager state.

Do not implement process recovery/adoption across Pi restarts in v1.

That feature is valuable, but it immediately adds PID identity, sidecar state, orphan adoption, and stale-process safety complexity. It is outside the minimal goal.

“Rediscover later” means `process.list` works across later turns in the same Pi runtime/session.

## 5.4 Recent history

Keep at most ~32 settled task metadata records in memory for `/ps` usability.

No model-visible full history tool is needed.

---

# 6. Logging and context isolation

## 6.1 Full disk log

For every command, create an owner-only session directory such as:

```text
/tmp/pi-background-processes/<session-run>/
```

Permissions:

```text
directory 0700
log file   0600
```

Use one combined log in arrival order for v1:

```text
p3.log
```

stdout and stderr handlers both append to it.

The file can be uncapped in the first release if simplicity wins, but document this clearly. A later log-rotation option is easy to add.

## 6.2 Bounded memory

Never accumulate the complete output in JS memory.

Maintain only a line ring buffer sufficient for:

- `process.peek`;
- completion tail;
- compact widget/detail previews.

Suggested ring size:

```text
200–500 lines
64–128 KiB hard byte cap
```

## 6.3 Model sanitation

Before sending tail text to the model:

- remove/normalize destructive terminal control sequences;
- clamp lines;
- clamp bytes;
- handle a single enormous line safely;
- preserve enough newline structure to read logs naturally.

The raw disk log remains untouched.

---

# 7. Human TUI

The human UI must add **zero model tools**.

## 7.1 Compact widget

Use Pi's widget API below the editor.

Collapsed form:

```text
■ 2 background processes • /ps
```

Optionally, when there are <= 3 active tasks:

```text
■ p2 tests  18s
■ p4 server 2m
```

Do not flood the screen.

Hide the widget when no tasks are active.

## 7.2 `/ps`

Implement one custom TUI overlay.

### List view

Show:

```text
id  state  elapsed  title
```

Keys:

```text
↑/↓ or j/k  select
Enter       inspect
x           kill selected task (with confirmation if desired)
Esc         close
```

### Detail/log view

Show:

```text
id / pid / pgid
state
command
started / elapsed
exit information

live log tail
```

Keys:

```text
↑/↓, PgUp/PgDn   scroll
G                return to live tail
x                kill if running
Esc              back
```

The view should update from manager output events while open.

Prefer event-driven UI invalidation over a permanent polling interval. A tiny refresh timer while the overlay is open is acceptable because this is **human UI polling**, not model polling, but the manager already receives output events so use them if convenient.

## 7.3 Important v1 scope boundary: this is a live log viewer, not a full PTY emulator

Do not call it a real terminal attach unless PTY support is implemented.

The v1 process is launched with writable stdin pipes, not a pseudo-terminal. Therefore:

- line-oriented programs can be interacted with;
- text/Enter/Ctrl-C/Ctrl-D can work;
- curses/full-screen apps such as `htop`, `lazygit`, `nvim`, `k9s` are **not** a v1 target.

This boundary is intentional to keep the package small.

---

# 8. Phase 2 — optional real PTY/attach

Only implement this after v1 is stable **and only if real full-screen terminal applications are a hard requirement**.

A PTY cannot be attached retroactively to a process originally spawned with normal pipes. PTY mode is a spawn-time architectural choice.

If Phase 2 is approved:

1. Add `node-pty`.
2. Use `@99percentpeople/pi-background-tasks` as the MIT implementation reference for:
   - PTY creation;
   - key token parsing;
   - resize handling;
   - attach/detach;
   - input forwarding.
3. Keep model surface unchanged:

```text
bash
process(list|peek|send|kill)
```

4. Do **not** add `bg_attach` or `write_stdin` model tools.
5. Human `/ps` detail can gain an `a`/`Enter` attach mode.
6. Decide PTY mode through user config, not model tool proliferation, e.g.:

```json
{
  "ptyMode": "never"
}
```

Possible later values:

```text
never
always
```

Avoid unreliable semantic command guessing unless there is a very strong reason.

Do not make PTY support a prerequisite for the first release.

---

# 9. Concrete fork cleanup

When starting from `pi-bg-tasks`, remove/merge the old public surface.

## Remove model tools

Remove registrations for concepts equivalent to:

```text
bg_list
bg_output
bg_stop
```

Replace with one `process` discriminated union.

## Remove explicit background choice from Bash

Remove model-facing:

```text
run_in_background
background
```

The extension owns the decision through elapsed runtime.

If the implementation internally still needs a `forceBackground()` method for Ctrl+Shift+B/human controls, keep that internal. Do not expose it in the model schema.

## Remove any wait/attach semantics from the model

There must be no action that blocks until completion.

## Keep useful internals

Preserve, where clean:

- child spawning;
- process group ownership;
- graceful/forced termination;
- disk logging;
- task registry;
- completion event plumbing;
- compact status UI;
- Ctrl+Shift+B only if it remains purely a **human** convenience.

---

# 10. File/module target

Do not over-architect. Target roughly this shape even if the fork has different filenames:

```text
src/
  index.ts              # register bash, process, /ps, lifecycle hooks
  process-manager.ts    # spawn, handoff, stdin, kill, settle
  output.ts             # ring tail + byte/line bounding + sanitization
  ui.ts                 # widget + /ps overlay
  types.ts              # tiny shared types if actually useful

tests/
  bash.test.ts
  process.test.ts
  completion.test.ts
  ui.test.ts             # only if the base already has practical TUI tests
```

If a type is only used once, keep it beside the implementation instead of creating extra files.

Target **zero production dependencies** beyond Pi-provided peer dependencies.

Dev dependencies for tests/typecheck are fine.

---

# 11. Implementation sequence

## Step 1 — freeze upstream

- Locate the real `pi-bg-tasks` repository from package metadata.
- Confirm MIT LICENSE.
- Checkout/tag the version matching the npm package.
- Record upstream commit in `UPSTREAM.md`.
- Run existing tests before modifying anything.

Do not proceed from a broken baseline.

## Step 2 — define contract tests first

Write tests for the desired public surface before refactoring internals:

- registered tool names exactly `bash` and `process` (plus Pi's unrelated normal tools, obviously);
- `process` actions exactly `list`, `peek`, `send`, `kill`;
- Bash schema has no explicit background flag;
- there is no `wait` action.

## Step 3 — normalize the manager lifecycle

Refactor the existing task manager enough that all process operations go through one internal API:

```ts
start(command, hardTimeout?)
markYielded(id)
list()
peek(id, limits)
send(id, input)
kill(id, reason)
shutdown()
subscribe(listener)
```

Do not expose this whole API to the model; it is internal.

## Step 4 — implement runtime auto-yield

- Spawn once.
- Race completion vs `yieldAfterMs`.
- Foreground winner returns final result.
- Timer winner returns background id.
- Same PID continues.
- Add the boundary-race test before moving on.

## Step 5 — make stdin writable

Change child stdio from stdin ignored to stdin piped.

Add `send` operation.

Do not add PTY yet.

## Step 6 — replace helper tools with `process`

Implement TypeBox discriminated union.

Keep output tiny.

## Step 7 — fix completion delivery

Use `followUp + triggerTurn`.

Add exactly-once guard.

Suppress completion for intentional kills/shutdown.

Add strict 15-line/8-KiB tail.

## Step 8 — enforce bounded output

- ring buffer;
- 100-line peek cap;
- byte caps;
- huge-line safety;
- raw full disk log.

## Step 9 — build human widget and `/ps`

Start with the smallest useful overlay:

1. task list;
2. Enter -> live tail;
3. x -> kill;
4. Esc/back navigation.

Do not build tabs, search, filtering, pinning, watchers, resource controls, SSH, scheduling, or terminal emulation.

## Step 10 — prompt guidance

Add the short “background task is a dependency, never wait/poll” guidance.

No long manual in the system prompt.

## Step 11 — delete inherited features that violate the concept

Search the package for:

```text
wait
poll
attach
run_in_background
background:
bg_
jobs
status tool
logs tool
```

Every remaining occurrence must be justified as internal/human UI/test text, not model API.

## Step 12 — manual test in real Pi

Use a clean invocation with only this extension enabled where possible.

Verify the actual transcript/TUI behavior, not only unit tests.

---

# 12. Acceptance tests

## A. Quick foreground command

Command:

```bash
printf 'hello\n'
```

Expected:

- returns normally in same Bash call;
- no background id;
- no completion wake later;
- no task remains active.

## B. Automatic handoff

Use a command longer than `yieldAfterMs`.

Expected:

- Bash returns after the yield window;
- task receives `pN` id;
- PID does not change/restart;
- task continues in background.

## C. Idle auto-wake

Let a background task be the only dependency and end the agent turn.

Expected:

- no polling;
- when process exits, Pi automatically starts a new model turn;
- completion event appears exactly once.

## D. Busy completion does not interrupt

Have a background task finish while the model is still doing useful independent work.

Expected:

- no mid-turn steering;
- completion arrives as a queued follow-up after the current run settles.

## E. Rediscovery

After several other turns:

```text
process(list)
```

Expected:

- active task is still discoverable with the same id.

## F. Peek bounding

Generate thousands of log lines.

Expected:

- disk log contains all output;
- `peek` returns only tail;
- <= 100 lines;
- <= 16 KiB;
- no full output enters context.

## G. Completion bounding

Generate lots of output then exit.

Expected completion message:

- exit metadata;
- <= 15 tail lines;
- <= 8 KiB.

## H. stdin text

Run a program that waits for a line from stdin and echoes it.

After handoff:

```text
process(send, id=pN, input="hello\n")
```

Expected:

- tool returns immediately;
- process receives input;
- later output shows `hello`;
- natural exit emits completion.

## I. Ctrl-C

Run a long command, then:

```text
process(send, id=pN, key="ctrl-c")
```

Expected:

- SIGINT reaches the process group;
- task settles appropriately;
- because this is an interaction rather than `kill`, natural SIGINT settlement can still report completion unless product policy chooses otherwise.

Document the chosen behavior and test it.

## J. Kill

```text
process(kill, id=pN)
```

Expected:

- descendants die as a group;
- log flushes;
- tool returns final acknowledgement;
- no later duplicate completion wake.

## K. Process-tree kill

Run a shell that starts a child `sleep` and waits.

Kill parent task.

Expected:

- child process is also gone.

## L. Race at yield boundary

Create deterministic/mocked tests where exit and yield timer resolve nearly simultaneously.

Expected:

```text
foreground final result XOR background completion
```

Never both; never neither.

## M. Output flood

Write output continuously for long enough to exceed normal transcript limits.

Expected:

- JS memory stays bounded;
- disk file grows;
- Pi remains responsive.

## N. Giant single line

Emit a multi-megabyte line with no newline.

Expected:

- peek/completion byte caps still hold.

## O. Session shutdown

With a background process active, run `/reload` or exit Pi.

Expected:

- process group terminated;
- log flushed;
- no completion wake generated during shutdown.

## P. Human `/ps`

Expected:

- widget shows active count;
- `/ps` list appears;
- selecting task opens live log view;
- output updates;
- `x` kills;
- no model messages are generated simply from viewing logs.

---

# 13. Explicit non-goals for v1

Do not implement:

- tmux;
- external supervisor daemon;
- workflow engine;
- DAG/dependency graph;
- task scheduler;
- cron;
- file/output watchers that wake on arbitrary matches;
- SSH remote execution;
- subagents;
- persistent process recovery after Pi restart;
- true PTY/full-screen TUI attach;
- log search;
- log pinning;
- model-facing full-log reader;
- model-facing wait;
- automatic polling;
- resource-priority controls;
- multiple shell/session abstractions.

Every one of these can be added later, but each makes the package less like the intended primitive.

---

# 14. Definition of done

The package is done when this exact interaction works:

```text
Agent -> bash("long test command")
Harness -> waits briefly
Harness -> returns: background process p2 still running
Agent -> continues useful independent work
Agent -> has nothing else useful to do, ends turn

... no model polling ...

Process p2 exits
Harness -> followUp completion event with exit info + 15-line tail
Harness -> wakes agent automatically
Agent -> continues from the dependency result
```

And at any later point:

```text
process(list)
process(peek, p2)
process(send, p2, ...)
process(kill, p2)
```

Meanwhile the human can:

```text
see compact widget
/ps
select p2
watch live output
kill it if necessary
```

If accomplishing a feature requires teaching the model another background-management primitive, stop and redesign it.

---

# 15. Ecosystem research notes / why the other packages are not the base

## `@richardgill/pi-background-bash`

**Closest technical philosophy.** Canonical Bash, same-process auto-handoff, disk log, follow-up completion, minimal `list|peek|kill`, footer.

Reject as the distributable fork base until licensing is explicit. Also lacks stdin/send, PTY, real human log viewer, completed registry, recovery.

Reference:
- https://pi.dev/packages/@richardgill/pi-background-bash
- https://github.com/richardgill/pi-extensions/tree/main/extensions/background-bash

## `@tian.zuo/pi-background-terminals`

**Best semantic + human UI reference.** Canonical Bash, 10s default yield, exact-once delivery, `followUp+triggerTurn`, full spill logs, bounded model output, compact widget, excellent `/ps` viewer.

Not the base because its Effect v4 runtime and cross-platform process machinery are much larger than needed, and it deliberately has no agent list/kill/stdin controls.

Reference:
- https://pi.dev/packages/@tian.zuo/pi-background-terminals
- https://github.com/TianZuo555/pi-extensions/tree/main/packages/pi-background-terminals

## `pi-bg-tasks`

**Recommended fork base.** MIT, zero-dependency core, canonical Bash override, auto-background behavior, completion notifications, simple task controls/UI.

Needed changes are conceptually small: merge helper tools, add stdin/send, use strict follow-up completion semantics, tighten model output, add proper `/ps` live viewer.

Reference:
- https://pi.dev/packages/pi-bg-tasks

## `pi-patty-bg-tasks`

Has Bash auto-backgrounding and a human shortcut, but exposes too many tools (`bash_bg`, `jobs`, `job_decide`, agents/monitoring) and its `attach` concept waits for completion. Too broad and violates the dependency/event model.

Reference:
- https://pi.dev/packages/pi-patty-bg-tasks

## `@99percentpeople/pi-background-tasks`

**Best PTY donor.** Real attach/detach, node-pty, key sending, resize/mouse/focus forwarding, polished human terminal interaction.

Reject as base because it intentionally exposes six `bg_*` tools including `bg_wait`, and its product model is explicit background tasks rather than transparent Bash auto-yield.

Reference:
- https://pi.dev/packages/@99percentpeople/pi-background-tasks
- https://github.com/99percentpeople/pi-extensions

## `@aliou/pi-processes`

Strong process manager, stdin/write, watches, logs, `/ps`, dock/status. But the model explicitly starts/manages a `process`; it is not transparent same-process Bash auto-yield. Its public action surface is larger than desired.

Reference:
- https://pi.dev/packages/@aliou/pi-processes
- https://github.com/aliou/pi-processes

## `@mjakl/pi-processes`

Smaller philosophy-aligned fork of process management with event-driven completion and good UI. However long Bash commands are not transparently handed off as the same process; the model is expected to use the process tool path. No stdin/write in the current public contract.

## `pi-unified-exec`

Good PTY/write-stdin and robust wake implementation, but its normal workflow includes bounded waits/poll calls. That directly conflicts with the core rule.

## `pi-background-bash` (mowenroot/mowenhacker package)

MIT, automatic 30s backgrounding, completion events, disk logs. However control is primarily through an additional `pbb` CLI/state layer and there is no stdin/PTY. More infrastructure than necessary for this project.

Reference:
- https://pi.dev/packages/pi-background-bash
- https://github.com/mowenroot/pi-background-bash

## `@ifi/pi-background-tasks`

Small MIT package with a useful dashboard, log files, and reactive wakeups. Ordinary Bash remains ordinary foreground Bash and background tasks are explicit, so it is better as a UI donor than as the execution base.

Reference:
- https://pi.dev/packages/@ifi/pi-background-tasks
- https://github.com/ifiokjr/oh-pi/tree/main/packages/background-tasks

## `@vanillagreen/pi-background-tasks`

Very polished dashboard/log/persistence system, but far larger and more featureful. Auto-backgrounding is mainly pre-spawn interception of configured/recognized blocking patterns rather than universal runtime handoff of the already-running Bash process. Too much machinery for this primitive.

Reference:
- https://pi.dev/packages/@vanillagreen/pi-background-tasks

## `@bytetrue/pi-background-terminal`

Minimal separate background path and human menu, but intentionally does not replace Bash. The model chooses a separate background tool, so it fails the main abstraction.

Reference:
- https://pi.dev/packages/@bytetrue/pi-background-terminal

## `pi-better-background-tasks`

Durable tasks/watchers/logs and remote/tmux-oriented capabilities. Useful if durability is the goal, not if minimal transparent Bash is the goal.

## `pi-background-tasks` (ismailsaleekh)

Extremely broad: shell jobs, delegated child agents, Fusion workflows, many tools/commands. It is essentially the workflow-engine direction this project explicitly wants to avoid.

Reference:
- https://pi.dev/packages/pi-background-tasks

## tmux-based Bash packages (`@richardgill/pi-tmux-bash`, `@aliaksei-raketski/pi-tmux-bash`, forks)

They solve observability/attach/durability well, but make tmux the execution substrate and generally expose tmux/polling semantics to the model. Reject by design.

## `pi-live-terminal`

Excellent tmux-backed live terminal UI reference, but again tmux becomes the abstraction. Reject as base.

## `pi-babysit`

External PTY supervisor with run/check/send/wait/kill semantics. Interactive and robust, but introduces another supervisor abstraction plus explicit waiting tools. Reject.

## `pi-bash-bg`

Very small support for shell `&`, but no task registry, wake, auto-yield, or UI. Too primitive.

## `pi-event-monitor`

Excellent demonstration of event-driven wake semantics without model polling, but it monitors events rather than owning the Bash process lifecycle. Reference only.

## `@fractaal/pi-agentic-processes`

Has auto-background/process-management infrastructure and a headless management API, but exposes a large legacy public tool surface (`bash_output`, `bash_tasks`, `kill_bash`, monitor tools, etc.). Useful architectural reference, not a minimal base.

---

# 16. Final implementation principle

Do not optimize for “background task features.”

Optimize for **one boring process primitive**:

```text
spawn once
return quickly when it proves long-running
keep logging
emit one completion event
allow tiny bounded inspection/control
show the human what is happening
```

That is the whole package.
