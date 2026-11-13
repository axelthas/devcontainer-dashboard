# Devcontainer Dashboard

A web dashboard for local devcontainers and Docker services, with workspace discovery,
container controls, embedded service UIs, and a terminal.

## Run the dashboard

Use the launcher on your Linux Docker host. You need Bash, Docker, and a non-root
operator account with access to the Docker daemon. Building also requires Docker
Buildx. You do not need Node.js on the host for either option below.

The dashboard has full Docker and terminal access. Run it only on a trusted host.
Keep the default loopback binding; use HTTPS for remote access.

### Option 1: build and run your checkout

From the repository root:

```bash
bash scripts/run-dashboard.sh --build
```

This builds the current working tree into the production image, starts a new test
container, and checks readiness. It does not publish an image or replace an existing
container.

- Open `http://127.0.0.1:3001` and log in with the password you entered.
- The default workspace is `~/ddash-production-workspace`.
- The launcher prints the container name, logs, stop/resume commands, and retained volumes.
- Each run creates a separate container and data volumes. Stop the previous instance
  before reusing its port, or pass another `--port`.

To use an existing workspace and another port:

```bash
bash scripts/run-dashboard.sh --build \
  --workspace "$HOME/git.workspaces" \
  --port 3002
```

### Option 2: pull and run the published image

From a checkout:

```bash
bash scripts/run-dashboard.sh
```

Or download the launcher without cloning the repository:

```bash
curl -fsSL https://raw.githubusercontent.com/axelthas/devcontainer-dashboard/main/scripts/run-dashboard.sh \
  -o run-dashboard.sh
bash run-dashboard.sh
```

This pulls `ghcr.io/axelthas/devcontainer-dashboard:latest` and runs it in the
foreground. It prompts for a workspace directory and password.

- Open `http://127.0.0.1:3000`.
- The default workspace is `~/ddash-workspace`.
- Ctrl+C stops the container. Data and shell-history volumes persist.
- Use `--image ghcr.io/axelthas/devcontainer-dashboard:TAG` to select another published tag.

Published images do not automatically include unmerged branch changes. Use `--build`
when testing this branch.

### Launcher options and remote access

```bash
bash scripts/run-dashboard.sh --help
```

Use `--password-file PATH --non-interactive` for unattended runs. Configuration is
passed through launcher flags, not exported deployment environment variables.
Workspace and socket bind paths must exist on the Docker host, including when you
invoke the launcher inside a devcontainer.

- [Launcher reference](scripts/README.md): identity, mounts, SSH/bootstrap options, and tests.
- [Tailscale HTTPS setup](tasks/ISSUE-27-HANDOFF.md): remote dashboard access and automatic
  HTTPS origins for OpenCode, OpenChamber, noVNC, and other allowed services. This is
  opt-in, requires a native Linux Docker host, and grants broad access to tailscaled.

## Rebuild an existing devcontainer

Use **Restart** to restart the same container without rebuilding its image or applying
changed devcontainer configuration.

Use **Rebuild and restart** (the hammer button) in either the devcontainer grid or list
when build inputs or configuration change:

1. Save changes to the Dockerfile or devcontainer configuration.
2. Select **Rebuild and restart** on the intended container.
3. Read the replacement warning.
4. Confirm the rebuild.
5. Follow the output in the build terminal.

The dashboard inspects the container's live `devcontainer.local_folder` and
`devcontainer.config_file` labels. Both paths must exist inside the configured workspace
root, including after resolving symlinks. Missing labels disable the action; invalid,
missing, ambiguous, or unsupported path metadata is rejected before replacement.
The exact labelled configuration is used, not another default in the repository.

The action runs `devcontainer up --remove-existing-container` with literal workspace,
configuration, and identity-label arguments. It uses the normal build cache. This is
not a no-cache build or a rollback facility. The CLI runs with the dashboard's configured
host identity and existing filtered child environment, including permitted values
supplied through the launcher's `--env-file`.

**Replacement interrupts services and container terminals and discards changes in the
container writable layer.** The dashboard does not delete workspace files or volumes
for this action. Configuration and lifecycle scripts can still change mounted data.
Back up important data before rebuilding. Compose configurations can also affect
related services; this action is not whole-project isolation.

Only one build or rebuild can run for a canonical workspace at a time. Browser
disconnect, reload, and view switching do not cancel the CLI process. Reattach through
the build terminal; failed builds also use the existing workspace log workflow.
The dashboard polls container discovery and uses the replacement container ID and
service bindings when it appears. Reopen container terminals against the new container.
An interrupted/failed rebuild can leave the original container removed; check output
and retry only after resolving the cause.

Run the focused source regressions with Node.js 22.13 or newer:

```bash
node --experimental-strip-types --test scripts/tests/devcontainer-rebuild.test.mjs
```

These tests use temporary files and mocked Docker/PTY boundaries. They do not replace
a real Docker/devcontainer acceptance test. On a disposable workspace, test a changed
Dockerfile/configuration with both running and stopped containers, reload while a build
runs, inspect mounted fixture data after replacement, and verify the replacement ID and
service ports. Do not use an operator's existing workspace as a test fixture.

## Develop the dashboard

You need Node.js 22, Docker access at `/var/run/docker.sock`, and a C++ build toolchain
with Python 3 for `node-pty` (on Ubuntu: `build-essential python3`).

```bash
git clone https://github.com/axelthas/devcontainer-dashboard.git
cd devcontainer-dashboard
npm ci
```

Start the development server with a workspace directory that already exists:

```bash
read -r -s -p 'Dashboard password: ' DASHBOARD_PASSWORD
printf '\n'
export DASHBOARD_PASSWORD
WORKSPACE_ROOT="$HOME/git.workspaces" npm run dev -- --host 127.0.0.1
```

Open the local URL printed by Vite. The password is required in development too.

A [VS Code devcontainer](.devcontainer/devcontainer.json) is also included. It installs
Node and build tools, but currently assumes a Linux host with `USER` and `HOME` set,
a running SSH agent (`SSH_AUTH_SOCK`), and `~/git.workspaces` available for its bind
mounts. Review those paths before choosing **Dev Containers: Reopen in Container**.
Run `npm ci` after opening it, then use the development command above. Inside the
devcontainer, omit `-- --host 127.0.0.1` so the configured port forwarding can reach Vite.

Common checks:

```bash
npm run check
npm run lint
npm run test:unit -- --run
npm run test:deployment
npm run test:tailscale
```

Use the production launcher to test the actual container runtime and Tailscale
integration. `npm run preview` does not provide terminal WebSocket support.

See [AGENTS.md](AGENTS.md) for the complete test commands and contribution conventions,
and [ARCHITECTURE.md](ARCHITECTURE.md) for the application structure.
