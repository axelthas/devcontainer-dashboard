# Host-matched production identity

This is the deployment identity contract introduced for issue #18. It supersedes
older examples that use `/home/ddash` or a fixed runtime user. The SSH transport
contract is defined in [SSH-AGENT.md](SSH-AGENT.md) for issue #63.

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

All four identity arguments and the host agent socket are required in both modes:

```bash
bash scripts/run-dashboard.sh --build \
  --host-user axel \
  --host-uid 1000 \
  --host-gid 1000 \
  --host-home /home/axel \
  --ssh-agent-socket /run/user/1000/ssh-agent.socket
```

Replace the sample values with the actual Docker-host identity and socket path.
The launcher does not select an identity from passwd, `id`, `SUDO_USER`, `USER`,
`HOME` or exported `HOST_*` variables. Missing and partial arguments fail. This
also applies under sudo, in systemd, with remote Docker hosts and when invoked
inside another container. Arguments must describe the daemon-host operator,
not necessarily the account running the launcher client.

`--host-name NAME` optionally supplies the dashboard's host label. It defaults
to unset. The launcher does not read `HOSTNAME` or discover a host name implicitly.

Root UID/GID is not supported. Existing image accounts must match exactly;
conflicting accounts fail rather than being renamed or repurposed. Home paths
must be canonical absolute paths without symlink parents. System directories,
shell interpolation characters and commas are rejected. Spaces are supported
in mounts. Structured build commands still have the separate shell-argument
limitation tracked in issue #11.

## Production launcher

```bash
bash scripts/run-dashboard.sh --build \
  --host-user axel --host-uid 1000 --host-gid 1000 --host-home /home/axel \
  --ssh-agent-socket /run/user/1000/ssh-agent.socket \
  --workspace /home/axel/ddash-production-workspace \
  --non-interactive --password-file /path/to/password
```

Build mode builds both application outputs through the Dockerfile, loads the
image locally, and starts a separate instance on loopback port 3001. It does not
publish, replace another instance, or use Vite preview. `--origin` still
configures an external HTTPS origin. Existing containers and data remain for
inspection.

Both launcher modes use the same explicit identity contract. Supply `--workspace`
and a password to avoid prompts; registry mode still prompts for the workspace
and password when a terminal is available. Bootstrap is disabled by default.
Supply `--bootstrap` to enable the bundled hook; omit it to keep the hook disabled.
`--no-bootstrap` has been removed and reports that migration guidance.

The launcher forwards the supplied identity into the container. Bind mounts fail
closed: a missing workspace source fails instead of silently creating a root-owned
directory. Restarting an old container does not change its configuration; start
a new one with updated flags.

## SSH and bind paths

Identity matching does not expose any host directory automatically. Never mount
the entire host home, or a parent such as `/home`. The entrypoint rejects this.
The home directory itself is container-private; only selected resources are
mounted below it. The workspace uses the same absolute path on both sides.

`--ssh-dir` and `--no-ssh-dir` have been removed. Do not mount the host `.ssh`
directory, even read-only: a process can still read and extract private keys.

`--ssh-agent-socket PATH` identifies the existing agent's absolute Docker-host
socket path. The launcher never falls back to the host's `SSH_AUTH_SOCK`. It mounts
the selected socket at the same path in DevHarbour and sets `SSH_AUTH_SOCK` inside
the container from that argument. The entrypoint verifies connectivity as the
configured non-root operator before hooks or server startup. A reachable agent
with no identities is permitted, with an explicit diagnostic. Missing or
inaccessible agents have no key-file fallback. No host socket permissions change.

Managed devcontainer builds and rebuilds add the same agent at a dedicated target,
set both container and remote environments, and verify access as the effective
remote user. Existing containers require explicit recreation to acquire a mount.
See [the SSH migration and lifecycle rules](SSH-AGENT.md) for Compose behavior,
remote UID access, socket replacement, trust boundaries and acceptance checks.

The optional bootstrap hook uses strict SSH host-key checking. Supply trusted
server keys with `--ssh-known-hosts /absolute/host/known_hosts`, an image trust
store, or an operator hook. The flag mounts only that file at
`/etc/ssh/ssh_known_hosts` in the dashboard. It does not provide host-key trust to
managed devcontainers automatically. The hook does not modify host SSH files or
trust unauthenticated keyscan output.

Docker resolves sibling-container bind sources on the daemon host. The agent
socket path must therefore be meaningful on that host. A proxy socket private to
an outer VS Code devcontainer is not a valid substitute. Matching HOME fixes
`${localEnv:HOME}` only when the configured resource exists at that host path.
It does not fix a literal `/home/ddash/.ssh` bind in a repository configuration.
Remove private-key directory mounts from those configurations explicitly. Other
host resources such as PulseAudio sockets, devices and required environment
values still need deliberate configuration.

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

Run the no-Docker regressions:

```bash
npm run test:deployment
npm run test:ssh
```

Mocked tests do not prove real privilege dropping or Docker behavior. Use the
native Linux acceptance checklist in [SSH-AGENT.md](SSH-AGENT.md), and record
actual container and production checks separately from source-only checks.
The legacy `container-smoke.sh` fixture requires migration away from its fake
`.ssh` directory mounts before it can validate the new SSH contract.
