# Deployment scripts

## Structure

Executable scripts define small, named functions and call one `main` entrypoint at
the end. `main` shows the execution order. Keep parsing, validation, preparation,
execution and verification separate. Document contracts and non-obvious safety
constraints, not every shell statement.

Node test files register tests with `node:test`; they are not command runners and
do not need an artificial `main`. The production smoke runner uses `async main()`.
The launcher is self-contained so it also works through `curl | bash`: registry
mode must not source repository files or require a checkout.

## The launcher

`run-dashboard.sh` is the single entrypoint for running the dashboard.

- Default (registry) mode pulls the selected image and runs it attached in the
  foreground with the stable `dashboard_data` and `ddash_zsh_data` named volumes.
  Ctrl+C stops the container; the volumes persist.
- `--build` builds this checkout with Docker Buildx, loads the image, creates a
  uniquely named test instance on host loopback, waits for the image healthcheck,
  and checks HTTP responses inside the container. Containers and volumes remain
  on success or failure for inspection. It never publishes an image or replaces
  another instance.

All inputs are explicit CLI flags; see `bash scripts/run-dashboard.sh --help` for
the full grammar. An exported `SSH_AUTH_SOCK` is required and identifies the
existing Docker-host SSH agent. It is mounted read-only at its original absolute
path; startup checks connectivity as the non-root operator. `SUDO_USER` selects
the passwd-based operator identity under sudo. Other deployment environment
variables (`DASHBOARD_*`, `DDASH_*`, `WORKSPACE_ROOT`, `HOST_*`, `SERVICE_PROXY_*`)
are ignored.

Common flags:

| Flag | Meaning |
| ---- | ------- |
| `--workspace PATH` | Workspace bind, source and target identical. Registry default `~/ddash-workspace`, build default `~/ddash-production-workspace`. |
| `--socket PATH` | Docker-host socket (default `/var/run/docker.sock`). |
| `--port N` | Published host port (registry default 3000, build default 3001). |
| `--bind-address ADDR` | Registry-mode publication address (default `127.0.0.1`). Build mode stays loopback-only. |
| `--origin URL` | External HTTP(S) origin, forwarded only when set. |
| `--password VALUE` | Explicit password (visible in process lists; prefer the file or prompt). |
| `--password-file PATH` | Read the password from a file, trimming one trailing newline. |
| `--env-file PATH` | Extend the container environment from a Docker env file; repeatable in both modes. |
| `--host-user/--host-uid/--host-gid/--host-home` | All-or-none Docker-host identity override. |
| `--bootstrap` / `--no-bootstrap` | dev-bootstrap startup hook (default off). |
| `--ssh-known-hosts PATH` | One trusted known_hosts file, mounted read-only in the dashboard. No key-directory mount. |
| `--no-create-workspace` | Skip local workspace creation for remote daemons. |
| `--non-interactive` | Disable all prompts; requires `--password` or `--password-file`. |
| `--gateway`, `--gateway-host`, `--gateway-ports` | Opt-in service-gateway passthroughs. |
| `--vscode-ssh-host VALUE` | `VSCODE_SSH_HOST` passthrough. |
| `--image REF` | Registry mode only: image reference. |
| `--platform`, `--name`, `--health-timeout` | Build mode only. Cross-mode flags fail with clear errors. |

`tern-dev-bootstrap.sh` lives in `plugins/` in the repository. The Dockerfile copies
it to `/opt/dashboard/plugins/`, and the entrypoint selects bundled hooks from
that directory; operator-supplied hooks stay under `/docker-entrypoint.d/`. The
hook command interface is unchanged: `docker run image dev-bootstrap`.

## Additional container environment

Use `--env-file` to provide variables that `devcontainer.json` references through
`${localEnv:NAME}`. The Dev Containers CLI runs inside the dashboard container,
so its local environment is the dashboard's environment, not the Docker host's.
The existing terminal environment filter still removes dashboard credentials,
`VSCODE_*` variables and editor launch hooks from child processes.

```bash
bash scripts/run-dashboard.sh --build \
  --env-file "$HOME/.config/devcontainer-dashboard/development.env"
```

Example file:

```text
GITLAB_USER=operator
ARTIFACT_REPOSITORY=https://artifacts.example.test
```

The file is read by the Docker client on the machine running the launcher. It is
not a Docker-host bind source, mounted into the container, or passed to the image
build. Relative paths resolve from the launcher's initial working directory,
including in build mode. Paths with spaces are supported when quoted.
Missing, unreadable and non-regular files fail before prompts or Docker calls.

Docker parses the file: use `NAME=value`, blank lines and `#` comment lines.
Values are literal, not shell expressions: do not use `export`, shell quoting,
command substitution or `${...}` expansion. A bare `NAME` asks Docker to copy
that variable from the Docker client's exported environment. Prefer explicit
`NAME=value` entries for reproducibility. The launcher never sources the file.

Repeat `--env-file` to layer files in argument order; later files take precedence.
Explicit container environment entries generated by the launcher take precedence
over all files, including the password, resolved host identity, workspace root
and selected `SSH_AUTH_SOCK`. The file does not configure launcher options or
replace `--password-file`. Variables without a launcher-generated override can
change application behavior, so review the file as trusted runtime configuration.

Protect files that contain secrets and keep them out of version control. The
launcher does not print file contents or put their values into Docker arguments,
but Docker stores container environment values in its metadata. Dashboard
operators, container processes and Docker administrators can access them. Child
commands can also print them; this feature is not a secret store. Recreate the
container after changing an env file; restarting it does not reload the file.

## Identity and resources

Supply all four `--host-user`, `--host-uid`, `--host-gid` and `--host-home` values
for an explicit Docker-host identity. Otherwise the launcher resolves the local
account from passwd, using `SUDO_USER` under sudo. Root UID/GID, partial
overrides, system home paths, traversal and noncanonical home spellings are
rejected. The entrypoint also checks actual home symlinks and account collisions
inside the container.

For remote daemons and launchers inside another container, set all four values
explicitly. Do not assume the launcher's filesystem is the daemon host's
filesystem. Use `--no-create-workspace` to avoid local directory creation and
provision the workspace on the daemon host separately. This flag does not add
remote-daemon support to the application: it still needs a host Unix socket
mounted at `/var/run/docker.sock`. `--socket` selects that bind source. The SSH
agent contract requires an actual daemon-host source path too, not a socket
private to an outer VS Code container.

Workspace paths stay identical on both sides. Docker `--mount` rejects missing
bind sources on the daemon host. No SSH directory is created to satisfy a mount.
Local directory existence is not used as proof that a remote daemon can bind it.
Docker's diagnostic identifies its missing source; build mode adds guidance when
container creation fails.

Keep `/data` and `/dashboard-history` for dashboard-owned named volumes only.
Keep the existing volume names when upgrading. Do not mount a host workspace,
SSH directory or home under these storage targets. The home itself is private to
the container; selected resource subdirectories can be mounted read-only.

## Bootstrap and SSH

Bootstrap is off by default. `--bootstrap` enables the bundled hook and every
run prints `dev-bootstrap: 0` or `1`.

`--ssh-dir` and `--no-ssh-dir` have been removed. Both report a migration error.
Export the existing Docker-host agent's `SSH_AUTH_SOCK` before launching. The
entrypoint verifies it as the operator before running hooks. A reachable agent
with no loaded identities is permitted; missing or inaccessible agents are not.
Private keys and the host `.ssh` directory are never mounted by the launcher.

```bash
ssh-add -l
bash scripts/run-dashboard.sh --build --bootstrap \
  --ssh-known-hosts "$HOME/.ssh/known_hosts"
```

`--ssh-known-hosts` mounts only that trusted file at `/etc/ssh/ssh_known_hosts` in
the dashboard. It provides host-key trust for dashboard Git/bootstrap, not managed
devcontainers automatically. Supply trust separately in their images or explicit
known_hosts-only configuration. Default bootstrap SSH uses BatchMode and strict
host-key checking. Do not trust unauthenticated keyscan output.

Build/rebuild actions forward the same host agent into the selected devcontainer,
set container and remote environments, and verify access as its remote user.
The target image needs a POSIX shell and `ssh-add`. Existing containers require
an explicit rebuild to add a socket mount. No socket permissions are changed.
Socket inode replacement requires recreation of DevHarbour and affected containers.
See [SSH-AGENT.md](../SSH-AGENT.md) for the full contract and acceptance checklist.

Use an available port. Build mode creates a new instance, not an update to the
old one. The selected hook fails startup if credentials are unavailable, cloning
fails, the installer is broken, or no shim is installed. An existing checkout is
reinstalled and can require GitLab access because its installer performs a pull.
Host SSH files are never rewritten. The provider installer creates
`~/.local/bin/devbootstrap`; the entrypoint includes that directory on PATH for
hooks, the server, terminals and builds.

Bootstrap resides in the container-private home, not a named volume. A newly
created container needs installation again. Do not assume a previous container's
writable layer or an old `/home/ddash/.devbootstrap` was migrated. Keep old
containers until you have preserved required state.

## Unattended use

`--non-interactive` disables all prompts and requires `--password` or
`--password-file`. The workspace then defaults per mode without prompting; the
registry-mode prompt only runs when a terminal is available and `--workspace`
was not given. `--origin` accepts an HTTP(S) origin without paths, credentials
or invalid ports; leave it unset for local HTTP. The service-gateway
passthroughs are forwarded only when their flags are set.

```bash
bash scripts/run-dashboard.sh --non-interactive \
  --password-file "$HOME/.secrets/dashboard-password" \
  --workspace "$HOME/ddash-workspace"
```

The application grants full operator capability; these mounts are not isolation.
Agent forwarding permits authentication/signing while connected. A read-only
socket bind does not restrict that authority.

## Validation

```bash
npm run test:deployment
npm run test:ssh
npm run check
npm run lint
npm run test:unit -- --run
npm run build
npm run build:server
npm run test:production
npm run test:e2e
```

Deployment tests use mocked privileged commands and Docker calls. They cover
identity flags and passwd fallback, sudo capture, the rejection matrix, password
prompt and file handling, origin and gateway validation, same-path mounts,
mode violations, unattended startup, retained resources, agent startup diagnostics
and password non-disclosure. They do not prove real privilege dropping, SSH
authentication or Docker behavior. `test:ssh` adds configuration/runner and rebuild
regressions, including named configurations and literal argv.

`production-smoke.mjs` tests a compiled server or disposable `SMOKE_BASE_URL`. It
checks health, login, WebSocket authorization and PTY output. Optional
`SMOKE_FIXTURE_WORKSPACE` starts a devcontainer through the authenticated
dashboard build API and waits for that persistent build terminal to exit. It is
not a dry run. Fixture builds require `SMOKE_BASE_URL` and
`SMOKE_FIXTURE_CLEANUP_OWNER=external`. The caller must own sibling-container
cleanup.

The legacy `container-smoke.sh` fixture still uses fake SSH-directory binds and
requires migration before it can validate this agent-only contract. Do not run
it as evidence of the new behavior. Use the native Linux checklist in
[SSH-AGENT.md](../SSH-AGENT.md) for real end-to-end acceptance.

Record the exact revision and commands actually run. A mocked suite passing is not
a successful production build or Docker integration result. Real agent forwarding,
actual Polaris localEnv requirements, persistent-build reconnect/cancellation,
shutdown and volume migration still need appropriate runtime tests. Structured
shell arguments for build paths remain coordinated with issue #11.
