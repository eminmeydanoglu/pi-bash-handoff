# pi-bash-handoff

```text
bash(command, timeout?)
process(list | peek | send | kill)
```

Pi extension for commands that take longer than expected.

Pi uses bash to run commands as usual. If one is still running after a short window, the tool ends and process continues in the background. Pi can keep working with other things, and will end the turn if the background process is a blocking one. When the process finishes, Pi is woken up with the result.


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

## Terminal Logs

Run /ps for a detailed view of the jobs. Enter to see full logs.


## Configuration

Optional project-local configuration lives at:

```text
.pi/background-processes.json
```

The main setting is `yieldAfterMs`, which controls how long a command stays in the foreground before being handed off. The default is 10 seconds.



