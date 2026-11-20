# Brain shell access (MCP)

The dashboard can give an MCP client, ClickUp Brain, shell access to individual containers. One MCP endpoint serves all containers. The operator grants access to one container at a time in the dashboard. Brain can use only the containers that the operator granted.

## Trust model

- A grant gives arbitrary commands as the container user. It also gives everything that the container reaches: mounts, credentials, networks and sockets.
- A container with the Docker socket mounted can control every container on the host. The grant dialog marks this as a danger. The operator must accept it explicitly.
- Brain cannot create, extend or widen grants. The MCP endpoint has no tools for grants, Docker, networks or the host.
- The MCP endpoint has its own listener and its own bearer token. Publishing it does not publish the dashboard UI, its cookies or its other routes.
- The dashboard password does not give MCP access, and the MCP token does not give dashboard access.

## Architecture

```text
ClickUp Brain
  -> HTTPS (Tailscale Funnel or another reverse proxy)
  -> host loopback, BRAIN_MCP_PORT
  -> dashboard process, dedicated MCP listener (POST /mcp, bearer token)
  -> grant check against live Docker state
  -> Docker exec API in the granted container, one PTY per command or persistent shell

Operator browser
  -> dashboard listener, GET /api/brain/terminal (WebSocket, session cookie, same origin)
  -> live output of one command or shell; keystrokes only after "Take over"
```

| Module                                        | Purpose                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `src/lib/server/brain/gateway.ts`             | Configuration, listener, bearer authentication and request limits      |
| `src/lib/server/brain/mcp.ts`                 | JSON-RPC: `initialize`, `ping`, `tools/list`, `tools/call`             |
| `src/lib/server/brain/tools.ts`               | The six tools, argument validation and the audit log entries           |
| `src/lib/server/brain/access.ts`              | Grant lifecycle, expiry, revocation and container-run checks           |
| `src/lib/server/brain/executions.ts`          | Docker exec runtime, output retention, stdin and verified cancellation |
| `src/lib/server/brain/shells.ts`              | Persistent shells: start script, prompt markers, typed commands        |
| `src/lib/server/brain/viewers.ts`             | Terminal viewer protocol: replay, live output, operator input          |
| `src/lib/server/brainTerminal.ts`             | WebSocket transport for terminal tabs, on the dashboard listener       |
| `src/lib/server/brain/exposure.ts`            | Reach analysis for the grant dialog                                    |
| `src/lib/server/brain/targets.ts`             | Live target inspection for SvelteKit routes (user, directory, reach)   |
| `src/lib/server/brain/state.ts`               | Process-wide state on `globalThis`, shared by both server bundles      |
| `src/lib/brainAccess.svelte.ts`               | Browser state, provided as context by the dashboard page               |
| `src/lib/components/BrainAccessButton.svelte` | Grant control on devcontainer rows, cards and service rows             |
| `src/lib/components/BrainPanel.svelte`        | Header control and panel: grants, commands, output and activity        |
| `src/lib/components/BrainTerminalTab.svelte`  | Terminal view of one command or shell, with Take over and Stop         |
| `src/lib/components/TerminalManager.svelte`   | Drawer: one Brain tab per container, with a list of its shells         |

The modules that the custom server imports use relative imports only, because `tsconfig.server.json` compiles them without SvelteKit aliases. `targets.ts` and `http.ts` are SvelteKit-only.

## Configuration

Use launcher flags instead of creating an environment file:

```bash
# Local MCP, published only on host loopback.
bash scripts/run-dashboard.sh --build --brain

# Public MCP through the existing mounted Tailscale socket.
bash scripts/run-dashboard.sh --build \
  --tailscale-socket /var/run/tailscale/tailscaled.sock \
  --origin https://YOUR-NODE.YOUR-TAILNET.ts.net \
  --brain-funnel
```

`--brain-funnel` implies `--brain`. It exposes only the dedicated bearer-protected MCP
listener, never the dashboard or the authenticated service gateway. It does not grant
access to any container. The operator must still use **Grant Brain**.

| Launcher flag             | Purpose                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `--brain`                 | Enable MCP. Create or reuse a private 64-character token in `/data/brain-mcp-token`.       |
| `--brain-token-file PATH` | Enable MCP with an existing Docker-host file, mounted read-only at `/run/brain-mcp-token`. |
| `--brain-port N`          | Local MCP port, default `3100`. Implies `--brain`.                                         |
| `--brain-funnel`          | Explicit public opt-in through LocalAPI. Requires the Tailscale socket and HTTPS origin.   |
| `--brain-funnel-port N`   | Public HTTPS port, default `10000`. Requires `--brain-funnel`.                             |

The public port must be `443`, `8443` or `10000`. It must not overlap the dashboard,
MCP, AI, gateway, or service allocation ports. The default `10000` is outside the
default service range `8400-8499`. Existing daemon entries on the requested port are
refused, including foreground, service, and disabled Funnel reservations.

In bridge mode the launcher publishes MCP as `127.0.0.1:<port>:<port>`, even when
the dashboard uses a wildcard bind. In Tailscale mode it uses host networking and the
MCP listener binds directly to host loopback. No separate CLI Funnel command is needed.

Tailscale must already have MagicDNS, HTTPS, and Funnel permission for this node.
The dashboard does not change tailnet policy or claim external reachability from a
successful LocalAPI write. A daemon/API or port-conflict failure prevents readiness.

Retrieve the generated token explicitly:

```bash
docker exec <dashboard-container> cat /data/brain-mcp-token
```

Use the URL from the Brain panel (also printed in startup logs) in the ClickUp MCP
connection. Set `Authorization: Bearer <token>`. The token is not returned by the
dashboard API or printed in logs. A supplied token file must be readable by the
container operator. Do not commit a token file.

The generated token persists in the dashboard data volume. A container restart reuses
it. Each new `--build` instance has a separate data volume, so a new build instance
gets a new token unless a stable `--brain-token-file` is supplied.

Without startup configuration the header shows **Brain disabled** with launch instructions.
The following environment variables remain available for direct deployments:

| Variable                | Default | Purpose                                                                    |
| ----------------------- | ------- | -------------------------------------------------------------------------- |
| `BRAIN_MCP_TOKEN`       | (empty) | Bearer token, 32 to 512 characters without whitespace                      |
| `BRAIN_MCP_TOKEN_FILE`  | (empty) | Absolute path of a file that contains the token. Use one of the two.       |
| `BRAIN_MCP_PORT`        | `3100`  | Listener port                                                              |
| `BRAIN_MCP_PUBLIC_URL`  | (empty) | HTTPS URL that the panel shows, for example the Funnel URL                 |
| `BRAIN_MCP_ENABLED`     | `0`     | `1` creates/reuses the automatic token when no explicit credential is set. |
| `BRAIN_MCP_FUNNEL`      | `0`     | `1` opts into public Funnel setup through the mounted socket.              |
| `BRAIN_MCP_FUNNEL_PORT` | `10000` | Public port for automatic Funnel setup.                                    |

The server reads the token at startup and removes `BRAIN_MCP_TOKEN` from its environment, so terminals and other child processes do not inherit it. A token in `--env-file` is still visible in `docker inspect` of the dashboard container. A token file keeps it out of the container configuration.

Explicit Brain launcher flags override legacy Brain settings from `--env-file`, including
the inline token and public URL. Other environment-file values are unchanged.

### Funnel ownership and cleanup

`src/lib/server/brain/startup.ts` reuses the ETag-protected Serve configuration client.
It adds the MCP TCP/Web pair and `AllowFunnel` entry only. It never resets Serve config.
A private journal at `/data/brain-funnel.json` records intent before the daemon write.
A process lock prevents concurrent use of the same journal.

Graceful shutdown removes only an exact owned TCP/Web/Funnel triple. Operator edits
transfer ownership and are preserved. The next start recovers a retained intent,
including when Funnel is now disabled, provided the same data volume and Tailscale
socket are retained. A hard kill or power loss can leave the route until this recovery;
the bearer-protected upstream is unavailable while the dashboard is stopped. Do not
reuse its local port for an unrelated unauthenticated service while a stale route remains.
Corrupt journals or uncertain locks require manual inspection rather than unsafe cleanup.

`npm run test:brain` includes launcher argument, token persistence, ownership, conflict,
restart recovery, ETag retry, and lost-response cleanup regressions. They use fake
Docker boundaries and a disposable Unix LocalAPI fixture, not a real public Funnel.

## Grants

1. The operator selects **Grant Brain** on a running container.
2. The dashboard inspects the container and shows the user, the start directory and the reach.
3. The operator selects a duration: 15 minutes, 1 hour or 4 hours.
4. When the reach contains a danger, the operator accepts it explicitly.
5. The server inspects the container again. It refuses the grant when `State.StartedAt` differs from the reviewed value.

The user is the devcontainer remote user, else the image user, else root. This is the same user as the **Open with** terminal. The start directory is the container workspace folder, else the image working directory.

A grant ends when:

- it expires,
- the operator revokes it (one grant or all grants),
- the container stops, restarts, is rebuilt or is removed. Every MCP call and every dashboard status poll compares the container ID and `State.StartedAt` with the grant.

When a grant ends, its running commands receive TERM, then KILL. Brain also loses access to the output of its earlier commands. The operator can still read retained output in the panel.

## Tools

| Tool               | Purpose                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| `list_targets`     | List granted containers with name, kind, Compose service, workspace, user and expiry |
| `open_shell`       | Start a persistent shell in one target and wait for its first prompt                 |
| `execute`          | Run a command in a shell, or start one process. Wait up to `wait_seconds` (20, ≤60). |
| `read_output`      | Read output from an absolute cursor, optionally after waiting for new output         |
| `write_stdin`      | Write to an interactive command, optionally followed by end-of-file                  |
| `cancel_execution` | Stop a command or close a shell, and report whether the stop was confirmed           |

`list_targets` also lists the open shells of each target: `shell_id`, name, `ready`, `busy`, controller and working directory.

Without `shell_id`, every `execute` call starts a new process with `bash -lc`, or `sh -lc` when bash is missing, in its own pseudo-terminal (PTY, 120 x 32). The working directory and variables do not carry over between calls. stdin is `/dev/null` unless `interactive` is true. Commands run with `TERM=dumb`, `NO_COLOR=1`, `PAGER=cat`, `GIT_PAGER=cat` and `GIT_TERMINAL_PROMPT=0`.

The PTY merges stdout and stderr, and its CRLF line endings are converted back to LF, so Brain reads output as without a terminal. For an interactive command, the PTY echoes input into the output. `close_stdin` sends Ctrl+D (end-of-file in canonical terminal mode); after that, Brain cannot write to the command again.

## Persistent shells

A one-off command per call is hard to follow: every command opens a tab, and nothing carries over. A shell is one long-lived interactive shell that Brain types commands into, as a person would. The operator sees one ordinary terminal with the user's prompt.

1. `open_shell` selects the first available interactive shell: zsh, bash, then sh. Zsh loads the user's `.zshenv` and `.zshrc`, respecting `ZDOTDIR`; bash loads `~/.bashrc`; sh loads its `ENV` file when set. Private integration files delete themselves. Shell names are unique among the open shells of a grant (default `main`, then `shell-2`).
2. Shell integration adds OSC sequences with a per-shell nonce. Terminals do not display them. A prompt hook reports the exit code and working directory. Zsh's `preexec` and bash's `PS0` (4.4 and later) also print a start marker after the echoed command line.
3. `execute` with `shell_id` types the command and Enter. Short printable single-line commands are typed as they are. Other commands (more than 200 characters, more than one line, TAB, control characters or a final backslash) are written to a private file in `/tmp` and sourced, so directory and variable changes still apply. The terminal shows `. '/tmp/.ddb-brain-….sh' # <first line>`. The file deletes itself.
4. The prompt marker ends the command. The result has `command_id`, `status` (the command's status), `exit_code`, `cwd` and the output between the start marker and the prompt marker, as plain text. Without a start marker (sh or bash before 4.4), the output starts after the first line feed of the echo.
5. `read_output` on a shell returns plain text, the shell `status`, `ready`, `cwd`, and `command` with the current or last command. While the cursor is inside a command, output stops at its prompt marker.

A shell runs one command at a time. `execute` is refused while the shell has not shown its first prompt, while Brain's command runs, while a job holds the terminal foreground (for example a program that the operator started), and while the operator has control. `write_stdin` with `"\u0003"` interrupts the current command.

Shells run with `TERM=xterm-256color`, `PAGER=cat`, `GIT_PAGER=cat` and `GIT_TERMINAL_PROMPT=0`. History expansion is off in zsh and bash, and history is not written to the user's history file. Zsh's `PROMPT_SP` is disabled to keep its prompt-padding marker out of command output. An open shell counts as one running command of its target.

Known limits: startup files that later replace the shell's prompt integration can remove the prompt marker, and commands then never end. An unclosed quote leaves the shell at its continuation prompt until Brain sends Ctrl+C. On sh and bash before 4.4, a typed command that wraps can leave part of its echo in the output.

## Terminal tabs and takeover

Brain's commands and shells in one container share one Brain tab in the terminal drawer, next to the shell tabs. When the tab holds more than one entry, a vertical list at its right selects between them (shells first), with a status for each: starting, idle, busy, running, you have control, or how it ended. The view shows the shell name or the command, the container, the user and the directory, live output, and **Stop** (**Close shell** for a shell). Closing the tab, or hiding an entry from the list, never stops a command or shell. **Open in terminal** in the Brain panel reopens any retained entry.

The tab is read-only while Brain has control. Input control is explicit:

1. **Take over** gives terminal input to the operator. The terminal resizes the PTY to its own size.
2. While the operator has control, `write_stdin`, `cancel_execution` and `execute` in that shell are refused. The tool results report `controller: "operator"`.
3. **Hand back to Brain** returns control. Brain can write to an interactive command again.

Brain can always read the output, including everything that the PTY echoes while the operator types. Programs that hide input (password prompts) do not echo it. For a command without Brain input, stdin is `/dev/null`: the operator's keys reach only programs that open `/dev/tty`, and Ctrl+C reaches the command's process group.

The audit log records `take_control` and `hand_back`, never typed input. The WebSocket uses the dashboard session and the same origin checks as the shell terminals. It is not available on the MCP listener. A viewer receives the newest 262,144 characters, then live output, and is closed when it cannot keep up (1 MB queued). At most 8 viewers can watch one command.

## Cancellation

Docker has no API to kill an exec process. The command wrapper prints its process ID before it replaces itself with the login shell. runc starts every exec process as a session leader, so that ID is also the process group ID. A stop then:

1. marks the command `stopping` and refuses further input from Brain and the operator,
2. sends TERM to the process group from a second exec as the same user,
3. waits up to 3 seconds, then sends KILL and waits up to 2 seconds,
4. reports `stopped` only when no process of the group remains, else `stop_unconfirmed`.

A shell uses job control, so each job has its own process group. Stopping a shell therefore signals every process in the shell's session (the session ID in `/proc/PID/stat`), not one process group.

Known limits: processes that leave the group or session (for example with `setsid`), processes that change user, and a reused process group ID after the group has ended.

## Limits

- 16 grants, 16 running commands, 4 running commands per target (an open shell counts as one), 64 retained commands for at most one hour.
- Commands and stdin writes: 16,384 characters. Output: the newest 1,000,000 characters per command; reads return at most 65,536 characters.
- Requests: 1 MiB body, 32 concurrent requests. Browser requests (with an `Origin` header) are refused.

## Audit

The panel shows the newest 50 of 200 retained entries: tool, target, command or execution ID, and the outcome. Refused calls are recorded. stdin content and command output are never recorded.

## Follow-ups

- Bind grants to a workspace or ticket, so `list_targets` can explain why a target matches a task.
- Replace the hand-written JSON-RPC layer with the MCP TypeScript SDK if more protocol features are needed.
