# pi-bash-handoff

```text
bash(command, timeout?)
process(list | peek | send | kill)
```

Pi extension for commands that take longer than expected.

Commands start in the foreground as usual. If one is still running after a short window, it automatically continues in the background. Pi can keep working, will end the turn if the process is blocking, and gets woken up when the process finishes.



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

