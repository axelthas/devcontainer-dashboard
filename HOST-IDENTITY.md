# Host-matched production identity

This is the deployment identity contract introduced for issue #18. It supersedes
older examples that use `/home/ddash`, a fixed runtime user, or an unconditional
SSH-agent mount.

## Contract

The dashboard is a host-integrated operator tool. Its runtime account matches the
intended Docker-host operator's username, UID, primary GID, and absolute home.
The account has Docker access and passwordless sudo, as the previous operator
account did. This is not a sandbox or a per-user authorization boundary.

The entrypoint starts as root. It creates or verifies the configured account,
adds the Docker socket group as a supplementary group, prepares dashboard-owned
storage, and drops privileges with `runuser`. Bundled hooks, operator hooks, the
server, terminals and builds run as the configured account. HOME, USER and
LOGNAME describe that account. The target devcontainer's remoteUser is separate.

Set all four values together for an explicit identity:

```bash
export HOST_USER=axel
export HOST_UID=1000
export HOST_GID=1000
export HOST_HOME=/home/axel
bash scripts/run-production.sh
```

Normal local launcher invocations capture the current account from passwd.
Under sudo, they select SUDO_USER. Partial overrides are rejected. For systemd,
remote Docker hosts, and launches inside another container, supply all four
values explicitly. The launcher cannot discover a remote daemon's operator.
Root UID/GID is not supported. Existing image accounts must match exactly;
conflicting accounts fail rather than being renamed or repurposed.

Home paths must be canonical absolute paths without symlink parents. System
directories, shell/Compose interpolation characters and commas are rejected.
Spaces are supported in mounts. Structured build commands still have the
separate shell-argument limitation tracked in issue #11.

## Production launcher

```bash
export DASHBOARD_PASSWORD='choose-a-strong-password'
bash scripts/run-production.sh --workspace "$HOME/ddash-production-workspace"
```

The runner builds both application outputs through the Dockerfile, loads the
image locally, and starts a separate instance on loopback port 3001. It does not
publish, replace another instance, or use Vite preview. ORIGIN still configures
an external HTTPS origin. Existing containers and data remain for inspection.

The direct installer and generated-Compose installer use the same identity
contract. Set WORKSPACE_ROOT and DASHBOARD_PASSWORD to avoid their respective
prompts. The Compose installer still prompts for the external origin.
DDASH_DEV_BOOTSTRAP=0 or 1 bypasses its hook prompt. The production and direct
launchers run without the bundled hook unless DDASH_DEV_BOOTSTRAP=1 is set.

For checked-in Compose, export the four HOST_* values before `docker compose up`.
Create WORKSPACE_ROOT first. Bind mounts use `create_host_path: false`, so a
missing source fails instead of silently creating a root-owned directory.
Generated Compose persists the selected identity and paths, but not the password.
Re-run the installer after changing identity; restarting an old container does
not change its configuration.

## SSH and bind paths

Identity matching does not expose any host directory automatically. Never mount
the entire host home, or a parent such as `/home`. The entrypoint rejects this.
The home directory itself is container-private; only selected resources are
mounted below it. The workspace uses the same absolute path on both sides.

To expose the host SSH directory:

```bash
DDASH_SSH_DIRECTORY=1 bash scripts/run-production.sh
```

This mounts HOST_HOME/.ssh read-only at the same absolute path. The directory
must already exist. Nothing creates an empty host SSH directory or copies keys
into the image. Do not put private keys in build arguments or environment values.

To forward an agent, export SSH_AUTH_SOCK to its absolute Docker-host path before
running a launcher. The socket is mounted at the same path inside the dashboard.
Unset SSH_AUTH_SOCK for no-agent operation. Agent access does not satisfy a
devcontainer configuration that explicitly requires a `.ssh` directory bind.
Agent permissions must allow the configured operator to connect.

The optional bootstrap hook uses strict SSH host-key checking. Supply a trusted
known_hosts through the selected read-only SSH directory. The bundled hook does
not modify host SSH files, chmod a read-only mount, or trust unauthenticated
keyscan output. For agent-only mode, prepare known_hosts before selecting the
bundled hook, or run bootstrap manually after an operator hook establishes trust.

Docker resolves sibling-container bind sources on the daemon host. Matching HOME
fixes `${localEnv:HOME}` when the configured resource is actually present there.
It does not fix a literal `/home/ddash/.ssh` in a repository configuration. Correct
that configuration explicitly. Other host resources such as PulseAudio sockets,
devices and required environment values still need deliberate configuration.

## Storage and upgrades

Global npm tools live under `/opt/dashboard-tools`, independent of HOME.
Shared shell assets live under `/opt/dashboard-shell`. Startup copies shell
templates only when the user's corresponding file does not exist.

Keep the existing named volumes. `dashboard_data` still mounts at `/data`.
`ddash_zsh_data` now mounts at `/dashboard-history`; its `.zsh_history` file is
unchanged. The production runner's `NAME-zsh` volume uses the same new target.
Recreate the container with updated mount targets, not the volumes.

The entrypoint migrates ownership recursively only inside these two
dashboard-owned storage paths. Do not bind host directories there. It changes
only the container-private home's top-level ownership, never recursively changes
the workspace or SSH files, and never changes Docker socket permissions.

Tools installed manually in an old container's writable layer are not persistent.
An old `/home/ddash/.devbootstrap` outside named storage is also not migrated.
Keep the old container until required local state is backed up. The optional
bootstrap hook can reinstall the provider in the new container-private home.

## Validation

Run the no-Docker regression suite:

```bash
node --test scripts/tests/deployment.test.mjs \
  scripts/tests/run-production.test.mjs scripts/tests/socket-symlink.test.mjs
```

Run the real integration fixture on a trusted local Linux Docker host:

```bash
bash scripts/tests/container-smoke.sh
```

It requires a non-root operator with a `/home` home, Docker Compose 2.24.4+, Node
22, util-linux `script`, installed project dependencies and network access. It
creates a temporary home under the operator's home with fake SSH data, checks
numeric ownership, starts the compiled production server, tests login/terminal
behavior, and starts a sibling devcontainer with a HOME-based bind. It removes
only its own test containers, volumes and temporary files. Images remain cached.

Mocked tests do not prove real privilege dropping or Docker behavior. Record
actual container and production checks separately from source-only checks.
