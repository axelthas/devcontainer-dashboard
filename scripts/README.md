# Deployment scripts

## Structure

Executable scripts define small, named functions and call one `main` entrypoint at
the end. `main` shows the execution order. Keep parsing, validation, preparation,
execution and verification separate. Document contracts and non-obvious safety
constraints, not every shell statement.

Node test files register tests with `node:test`; they are not command runners and
do not need an artificial `main`. The production smoke runner uses `async main()`.
The three launchers deliberately contain the same `resolve_identity` function so
that each installer still works through `curl | bash`. Regression tests compare it.
Do not introduce an unversioned downloaded helper to remove this duplication.

## Choose a launcher

- `run-production.sh`: build this checkout with Buildx, load the image, create a
  separate test instance, wait for health and check HTTP responses. It retains
  containers and volumes on success or failure. It never publishes an image.
- `run-dashboard.sh`: pull the selected image and run it in the foreground with
  the stable `dashboard_data` and `ddash_zsh_data` named volumes.
- `run-dashboard-compose.sh`: validate and write Compose configuration, pull the
  selected image and run Compose in the foreground. The password remains an
  environment reference. A failed Compose render leaves the prior file intact.
- `10-dev-bootstrap.sh`: explicitly selected startup hook. Clone or reinstall the
  provider, then require a `devbootstrap` command on PATH before server startup.

## Identity and resources

Supply all four `HOST_USER`, `HOST_UID`, `HOST_GID` and `HOST_HOME` values for an
explicit Docker-host identity. Otherwise the launchers resolve the local account
from passwd, using `SUDO_USER` under sudo. Root UID/GID, partial overrides, system
home paths, traversal and noncanonical home spellings are rejected. The entrypoint
also checks actual home symlinks and account collisions inside the container.

For remote daemons, services and launchers inside another container, set all four
values explicitly. Do not assume the launcher's filesystem is the daemon host's
filesystem. Set `DDASH_CREATE_WORKSPACE=0` to avoid local directory creation and
provision the workspace on the daemon host separately. This switch does not add
remote-daemon support to the application: it still needs a host Unix socket mounted
at `/var/run/docker.sock`. `DOCKER_SOCKET` selects that bind source in all launchers.

Workspace paths stay identical on both sides. Docker `--mount` and Compose
`create_host_path: false` reject missing bind sources on the daemon host. No SSH
directory is created to satisfy a mount. Local directory existence is not used as
proof that a remote daemon can bind it. Docker's diagnostic identifies its missing
source. The production runner adds guidance when container creation fails.

Keep `/data` and `/dashboard-history` for dashboard-owned named volumes only.
Keep the existing volume names when upgrading; change the old history mount target
from `/home/ddash/.zsh_data` to `/dashboard-history`. Do not mount a host workspace,
SSH directory or home under these storage targets. The home itself is private to
the container; selected resource subdirectories can be mounted read-only.

## Bootstrap and SSH

Bootstrap is off by default in the production and direct launchers. The interactive
Compose installer asks. Every launcher prints `dev-bootstrap: 0` or `1`.

```bash
DDASH_DEV_BOOTSTRAP=1 DDASH_SSH_DIRECTORY=1 \
  bash scripts/run-production.sh --port 3002
```

Use an available port. This creates a new instance, not an update to the old one.
`DDASH_SSH_DIRECTORY=1` mounts `HOST_HOME/.ssh` read-only at the same absolute path.
An exported `SSH_AUTH_SOCK` is forwarded at its original absolute daemon-host path;
unset it for no-agent operation. Neither is required when bootstrap is disabled.
Agent-only operation requires an independently supplied trusted host-key setup.
An agent does not satisfy a devcontainer config that requires an SSH directory bind.

The selected hook fails startup if credentials are unavailable, cloning fails,
the installer is broken, or no shim is installed. An existing checkout is reinstalled
and can require GitLab access because its installer performs a pull. Default SSH
uses BatchMode and strict host-key checking. Host SSH files are never rewritten.
The provider installer creates `~/.local/bin/devbootstrap`; the entrypoint includes
that directory on PATH for hooks, the server, terminals and builds.

Bootstrap resides in the container-private home, not a named volume. A newly created
container needs installation again. Do not assume a previous container's writable
layer or an old `/home/ddash/.devbootstrap` was migrated. Keep old containers until
you have preserved required state.

## Unattended startup

Set `DDASH_NONINTERACTIVE=1` to disable all prompts. Supply `DASHBOARD_PASSWORD`
through the environment. The direct and Compose installers also require
`WORKSPACE_ROOT`. Set `ORIGIN` (or `DDASH_ORIGIN`) to an HTTP(S) origin, or leave it
empty for local HTTP. Compose validates the origin and fails without retrying in
unattended mode. Set `DDASH_DEV_BOOTSTRAP=0` or `1` deliberately. The opt-in service
gateway variables (`SERVICE_PROXY_ENABLED`, `SERVICE_PROXY_HOST`,
`SERVICE_PROXY_PORTS`) are forwarded to the test container when set; empty values keep
the gateway disabled.

```bash
export DDASH_NONINTERACTIVE=1
export DDASH_DEV_BOOTSTRAP=0
export WORKSPACE_ROOT="$HOME/ddash-workspace"
# Supply DASHBOARD_PASSWORD securely in the invoking environment.
bash scripts/run-dashboard-compose.sh
```

`DDASH_CONFIG_DIR` overrides the Compose output directory. Generated configuration
persists identity, paths and origin, not the password. Re-run the installer when
these values change. Both installers default to loopback publication, with an
explicit `DASHBOARD_BIND_ADDRESS` override. The production runner stays loopback-only.
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
identity, sudo capture, script structure, optional bootstrap, missing credentials,
installer failures, shim PATH, origin validation, same-path mounts, unattended
startup, retained resources and password non-disclosure. They do not prove real
privilege dropping, SSH authentication or Docker behavior.

`production-smoke.mjs` tests a compiled server or disposable `SMOKE_BASE_URL`. It
checks health, login, WebSocket authorization and PTY output. Optional
`SMOKE_FIXTURE_WORKSPACE` starts a devcontainer through the authenticated dashboard
build API and waits for that persistent build terminal to exit. It is not a dry run.
Fixture builds require `SMOKE_BASE_URL` and `SMOKE_FIXTURE_CLEANUP_OWNER=external`.
The caller must own sibling-container cleanup; prefer `container-smoke.sh`, which
removes the exact unique fixture containers even after a failed API request.

`container-smoke.sh` requires a non-root local Linux Docker operator with a `/home`
home, Compose 2.24.4+, Node 22, installed dependencies and network access. Its named
functions prepare a disposable fixture, render Compose, build/start the image,
exercise the dashboard build API, verify read-only HOME substitution and ownership,
and test fail-closed startup. It cleans up only its unique fixture resources.
It uses fake SSH data and an operator-hook bootstrap stub to test provider discovery
and PATH, not real private keys or a real GitLab installation. The sibling fixture
uses explicit `remoteUser: root`, separate from the dashboard operator.

Record the exact revision and commands actually run. A mocked suite passing is not
a successful production build or Docker integration result. Real agent forwarding,
actual Polaris localEnv requirements, persistent-build reconnect/cancellation,
shutdown and volume migration still need appropriate runtime tests. Structured
shell arguments for build paths remain coordinated with issue #11.
