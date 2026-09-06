# pi-bash-handoff

A deliberately small Pi extension: long `bash` commands are started once,
return normally when quick, or automatically hand off after a configurable
foreground window. A background process writes a full owner-only disk log and
emits one `followUp` completion event. It is an asynchronous dependency, not a
thing an agent polls or waits for.

## Model interface

The extension registers only two model-facing tools:

```text
bash(command, timeout?)
process(list | peek | send | kill)
```

## Install

Install into the current, trusted Pi project from the tagged GitHub release:

```sh
pi install git:github.com/eminmeydanoglu/pi-bash-handoff@v0.1.0 --local
```

Then restart Pi from that project. To develop this checkout directly instead,
retain the project package entry and run `pi` from this directory.

For a global Pi installation, omit `--local`:

```sh
pi install git:github.com/eminmeydanoglu/pi-bash-handoff@v0.1.0
```

`timeout` is a total-runtime hard timeout in seconds; it is unrelated to the
10-second default handoff window. `process.peek` returns a bounded tail (at
most 100 lines / 16 KiB). Full combined stdout/stderr logs live in an owner-only
session directory under `/tmp/pi-background-processes` and are never offered
as a model-facing full-log reader.

`process` is sent to model providers as one flat JSON object rather than a
root `anyOf` union. This is intentional: it keeps tool-call generation reliable
with CommandCode GLM. `action` is required and is one of `list`, `peek`,
`send`, or `kill`; `id` is required for every action except `list`; and `send`
requires exactly one of `input` or `key`. The extension enforces those
action-specific rules at execution time.

V1 uses stdin pipes, not a PTY. Line-oriented programs can receive text,
Enter, Ctrl-C, Ctrl-D, Escape, Tab, and Backspace. Full-screen applications are
intentionally out of scope.

## Project configuration

Configuration is deliberately project-local and is read once when Pi starts
the extension. Copy `background-processes.example.json` to
`.pi/background-processes.json`, or create that file directly. A missing file
uses these same defaults:

```json
{
  "yieldAfterMs": 10000,
  "killGraceMs": 1000,
  "peekDefaultLines": 80,
  "peekMaxLines": 100,
  "peekMaxBytes": 16384,
  "completionLines": 15,
  "completionMaxBytes": 8192,
  "recentTaskLimit": 32,
  "memoryTailMaxLines": 400,
  "memoryTailMaxBytes": 131072
}
```

- `yieldAfterMs`: foreground time before automatic handoff; it is not the
  per-command hard timeout.
- `killGraceMs`: time between `SIGTERM` and escalation to `SIGKILL` for an
  intentional `process.kill`.
- `peek*` and `completion*`: bounded model-facing output; they never change
  the complete owner-only disk log.
- `recentTaskLimit`: number of settled task summaries retained for `list` and
  `/ps`.
- `memoryTail*`: memory retained for live `peek`, completion, and UI tails.

Every configured value must be an integer in its documented safe range. Unknown
keys and invalid values fail Pi startup rather than silently altering task
lifecycle behavior.

Run `/ps` for the human-only live process viewer. The small widget appears only
while work is active. `/ps` has list/detail views, live event-driven updates,
and `x` to kill a selected active task.

## Development

```sh
npm install
npm run check
pi --extension ./src
```

The process manager is session-scoped. Pi session shutdown terminates owned
process groups, flushes logs, and intentionally generates no completion wake.

## Release contract

The model-facing contract is `bash(command, timeout?)` plus the four `process`
actions. Changes to those schemas, their lifecycle semantics, or completion
delivery are breaking behavior. While this package is below `1.0.0`, use patch
releases for fixes and minor releases for intentional contract changes.

Before publishing, run:

```sh
npm run check
npm pack --dry-run
git status --short
```

The published source of truth is the GitHub tag. The package manifest includes
the matching repository, homepage, and issue-tracker metadata.
