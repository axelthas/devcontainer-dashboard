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
the full grammar. The launcher reads no deployment environment. An exported
`SSH_AUTH_SOCK` is forwarded read-only at its original absolute path, and
`SUDO_USER` selects the passwd-based operator identity under sudo. Everything
else (`DASHBOARD_*`, `DDASH_*`, `WORKSPACE_ROOT`, `HOST_*`, `SERVICE_PROXY_*`)
is ignored.

Common flags:

| Flag                                             | Meaning                                                                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `--workspace PATH`                               | Workspace bind, source and target identical. Registry default `~/ddash-workspace`, build default `~/ddash-production-workspace`. |
| `--socket PATH`                                  | Docker-host socket (default `/var/run/docker.sock`).                                                                             |
| `--port N`                                       | Published host port (registry default 3000, build default 3001).                                                                 |
| `--bind-address ADDR`                            | Registry-mode publication address (default `127.0.0.1`). Build mode stays loopback-only.                                         |
| `--origin URL`                                   | External HTTP(S) origin, forwarded only when set.                                                                                |
| `--password VALUE`                               | Explicit password (visible in process lists; prefer the file or prompt).                                                         |
| `--password-file PATH`                           | Read the password from a file, trimming one trailing newline.                                                                    |
| `--host-user/--host-uid/--host-gid/--host-home`  | All-or-none Docker-host identity override.                                                                                       |
| `--bootstrap` / `--no-bootstrap`                 | dev-bootstrap startup hook (default off).                                                                                        |
| `--ssh-dir` / `--no-ssh-dir`                     | Read-only `HOST_HOME/.ssh` bind (default off).                                                                                   |
| `--no-create-workspace`                          | Skip local workspace creation for remote daemons.                                                                                |
| `--non-interactive`                              | Disable all prompts; requires `--password` or `--password-file`.                                                                 |
| `--gateway`, `--gateway-host`, `--gateway-ports` | Opt-in service-gateway passthroughs.                                                                                             |
| `--vscode-ssh-host VALUE`                        | `VSCODE_SSH_HOST` passthrough.                                                                                                   |
| `--image REF`                                    | Registry mode only: image reference.                                                                                             |
| `--platform`, `--name`, `--health-timeout`       | Build mode only. Cross-mode flags fail with clear errors.                                                                        |

`10-dev-bootstrap.sh` lives in `plugins/` in the repository. The Dockerfile copies
it to `/opt/dashboard/plugins/`, and the entrypoint selects bundled hooks from
that directory; operator-supplied hooks stay under `/docker-entrypoint.d/`. The
hook command interface is unchanged: `docker run image dev-bootstrap`.

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
mounted at `/var/run/docker.sock`. `--socket` selects that bind source.

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
run prints `dev-bootstrap: 0` or `1`. `--ssh-dir` mounts `HOST_HOME/.ssh`
read-only at the same absolute path. An exported `SSH_AUTH_SOCK` is forwarded at
its original absolute daemon-host path; unset it for no-agent operation. Neither
is required when bootstrap is disabled. Agent-only operation requires an
independently supplied trusted host-key setup. An agent does not satisfy a
devcontainer config that requires an SSH directory bind.

```bash
bash scripts/run-dashboard.sh --build --port 3002 --bootstrap --ssh-dir
```

Use an available port. Build mode creates a new instance, not an update to the
old one. The selected hook fails startup if credentials are unavailable, cloning
fails, the installer is broken, or no shim is installed. An existing checkout is
reinstalled and can require GitLab access because its installer performs a pull.
Default SSH uses BatchMode and strict host-key checking. Host SSH files are never
rewritten. The provider installer creates `~/.local/bin/devbootstrap`; the
entrypoint includes that directory on PATH for hooks, the server, terminals and
builds.

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

## Validation

```bash
npm run test:deployment
npm run check
npm run lint
npm run test:unit -- --run
npm run build
npm run build:server
npm run test:production
npm run test:e2e
bash scripts/tests/container-smoke.sh
```

Deployment tests use mocked privileged commands and Docker calls. They cover
identity flags and passwd fallback, sudo capture, the rejection matrix, password
prompt and file handling, origin and gateway validation, same-path mounts,
mode violations, unattended startup, retained resources and password
non-disclosure. They do not prove real privilege dropping, SSH authentication or
Docker behavior.

`production-smoke.mjs` tests a compiled server or disposable `SMOKE_BASE_URL`. It
checks health, login, WebSocket authorization and PTY output. Optional
`SMOKE_FIXTURE_WORKSPACE` starts a devcontainer through the authenticated
dashboard build API and waits for that persistent build terminal to exit. It is
not a dry run. Fixture builds require `SMOKE_BASE_URL` and
`SMOKE_FIXTURE_CLEANUP_OWNER=external`. The caller must own sibling-container
cleanup; prefer `container-smoke.sh`, which removes the exact unique fixture
containers even after a failed API request.

`container-smoke.sh` requires a non-root local Linux Docker operator with a
`/home` home, Node 22, installed dependencies and network access. Its named
functions prepare a disposable fixture, build/start the image with plain
`docker run` mirroring the launcher argv, exercise the dashboard build API,
verify read-only HOME substitution and ownership, and test fail-closed startup.
It cleans up only its unique fixture resources. It uses fake SSH data and an
operator-hook bootstrap stub to test provider discovery and PATH, not real
private keys or a real GitLab installation. The sibling fixture uses explicit
`remoteUser: root`, separate from the dashboard operator.

Record the exact revision and commands actually run. A mocked suite passing is not
a successful production build or Docker integration result. Real agent forwarding,
actual Polaris localEnv requirements, persistent-build reconnect/cancellation,
shutdown and volume migration still need appropriate runtime tests. Structured
shell arguments for build paths remain coordinated with issue #11.
