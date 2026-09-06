# pi-bash-handoff

```text
bash(command, timeout?)
process(list | peek | send | kill)
```

Pi extension for commands that take longer than expected.

Commands start in the foreground as usual. If one is still running after a short window, it automatically continues in the background. Pi can keep working, end the turn if blocked, and gets woken up when the process finishes.

## Why

Long-running shell commands create an awkward choice for coding agents: block the turn waiting for completion, or manually push work into the background and keep checking it.

To solve, we modify the bash tool:

1. Start normally with `bash`.
2. Return normally if it finishes quickly.
3. Hand off to the background if it does not.
4. Notify Pi once when it completes.



## Install

```sh
pi install git:github.com/eminmeydanoglu/pi-bash-handoff@v0.1.0 --local
```

Restart Pi from the project.

For a global installation, omit `--local`.

## Process control

`process` exists for Pi to inspect or control a running task.

```text
process(list)
process(peek, id)
process(send, id, input | key)
process(kill, id)
```

`peek` returns a bounded output tail. Full stdout/stderr is written to an owner-only session log.

## Configuration

Optional project-local configuration lives at:

```text
.pi/background-processes.json
```

The main setting is `yieldAfterMs`, which controls how long a command stays in the foreground before being handed off. The default is 10 seconds.

A `bash` `timeout` is separate: it remains a hard total-runtime limit even after handoff.

