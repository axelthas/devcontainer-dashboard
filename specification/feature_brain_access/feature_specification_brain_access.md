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
  -> Docker exec API in the granted container
```

| Module                                        | Purpose                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `src/lib/server/brain/gateway.ts`             | Configuration, listener, bearer authentication and request limits      |
| `src/lib/server/brain/mcp.ts`                 | JSON-RPC: `initialize`, `ping`, `tools/list`, `tools/call`             |
| `src/lib/server/brain/tools.ts`               | The five tools, argument validation and the audit log entries          |
| `src/lib/server/brain/access.ts`              | Grant lifecycle, expiry, revocation and container-run checks           |
| `src/lib/server/brain/executions.ts`          | Docker exec runtime, output retention, stdin and verified cancellation |
| `src/lib/server/brain/exposure.ts`            | Reach analysis for the grant dialog                                    |
| `src/lib/server/brain/targets.ts`             | Live target inspection for SvelteKit routes (user, directory, reach)   |
| `src/lib/server/brain/state.ts`               | Process-wide state on `globalThis`, shared by both server bundles      |
| `src/lib/brainAccess.svelte.ts`               | Browser state, provided as context by the dashboard page               |
| `src/lib/components/BrainAccessButton.svelte` | Grant control on devcontainer rows, cards and service rows             |
| `src/lib/components/BrainPanel.svelte`        | Header control and panel: grants, commands, output and activity        |

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

| Launcher flag | Purpose |
| --- | --- |
| `--brain` | Enable MCP. Create or reuse a private 64-character token in `/data/brain-mcp-token`. |
| `--brain-token-file PATH` | Enable MCP with an existing Docker-host file, mounted read-only at `/run/brain-mcp-token`. |
| `--brain-port N` | Local MCP port, default `3100`. Implies `--brain`. |
| `--brain-funnel` | Explicit public opt-in through LocalAPI. Requires the Tailscale socket and HTTPS origin. |
| `--brain-funnel-port N` | Public HTTPS port, default `10000`. Requires `--brain-funnel`. |

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

| Variable               | Default | Purpose                                                              |
| ---------------------- | ------- | -------------------------------------------------------------------- |
| `BRAIN_MCP_TOKEN`      | (empty) | Bearer token, 32 to 512 characters without whitespace                |
| `BRAIN_MCP_TOKEN_FILE` | (empty) | Absolute path of a file that contains the token. Use one of the two. |
| `BRAIN_MCP_PORT`       | `3100`  | Listener port                                                        |
| `BRAIN_MCP_PUBLIC_URL` | (empty) | HTTPS URL that the panel shows, for example the Funnel URL           |
| `BRAIN_MCP_ENABLED` | `0` | `1` creates/reuses the automatic token when no explicit credential is set. |
| `BRAIN_MCP_FUNNEL` | `0` | `1` opts into public Funnel setup through the mounted socket. |
| `BRAIN_MCP_FUNNEL_PORT` | `10000` | Public port for automatic Funnel setup. |

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
| `execute`          | Start a command in one target. Wait up to `wait_seconds` (default 20, maximum 60).   |
| `read_output`      | Read output from an absolute cursor, optionally after waiting for new output         |
| `write_stdin`      | Write to an interactive command, optionally followed by end-of-file                  |
| `cancel_execution` | Stop a command and report whether the stop was confirmed                             |

Every `execute` call starts a new process with `bash -lc`, or `sh -lc` when bash is missing. The working directory and variables do not carry over between calls. stdin is closed unless `interactive` is true. Commands run with `TERM=dumb`, `NO_COLOR=1`, `PAGER=cat`, `GIT_PAGER=cat` and `GIT_TERMINAL_PROMPT=0`.

## Cancellation

Docker has no API to kill an exec process. The command wrapper prints its process ID before it replaces itself with the login shell. runc starts every exec process as a session leader, so that ID is also the process group ID. A stop then:

1. marks the command `stopping` and refuses further stdin,
2. sends TERM to the process group from a second exec as the same user,
3. waits up to 3 seconds, then sends KILL and waits up to 2 seconds,
4. reports `stopped` only when no process of the group remains, else `stop_unconfirmed`.

Known limits: processes that leave the group (for example with `setsid`), processes that change user, and a reused process group ID after the group has ended.

## Limits

- 16 grants, 16 running commands, 4 running commands per target, 64 retained commands for at most one hour.
- Commands and stdin writes: 16,384 characters. Output: the newest 1,000,000 characters per command; reads return at most 65,536 characters.
- Requests: 1 MiB body, 32 concurrent requests. Browser requests (with an `Origin` header) are refused.

## Audit

The panel shows the newest 50 of 200 retained entries: tool, target, command or execution ID, and the outcome. Refused calls are recorded. stdin content and command output are never recorded.

## Follow-ups

- Show Brain commands as read-only tabs in the terminal drawer, with an explicit take-over.
- Bind grants to a workspace or ticket, so `list_targets` can explain why a target matches a task.
- Replace the hand-written JSON-RPC layer with the MCP TypeScript SDK if more protocol features are needed.
