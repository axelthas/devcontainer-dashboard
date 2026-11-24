# DevHarbour

![DevHarbour puffin logo in the Nord colour palette](static/devharbour-logo.svg)

A self-hosted control center for development environments. Discover local repositories,
build and manage devcontainers, run Docker Compose sandboxes, and access terminals,
editors, AI coding tools, and project services from one browser interface.

Formerly **Devcontainer Dashboard**. This is a branding change, not a deployment
migration. The repository URL, published image, launcher commands, environment
variables, retained volumes, browser storage keys, and MCP server identifier keep
their existing names. Existing installations do not need to move or reset data.

The puffin uses the dashboard's Nord palette for now: Polar Night `#2e3440`,
Snow Storm `#eceff4`, Frost `#88c0d0`, and Aurora orange `#d08770` and yellow `#ebcb8b`.
The [app icon](src/lib/assets/favicon.svg) and [wordmark](static/devharbour-logo.svg)
are self-contained SVGs with no external fonts or raster images.
The iPhone home-screen icon [static/apple-touch-icon.png](static/apple-touch-icon.png)
is a PNG, because iOS ignores SVG icons there. It is generated from the app icon.
After you change the app icon, run `node scripts/generate-app-icons.mjs` and commit
the new PNG.

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
background. It prompts for a workspace directory and password.

- Open `http://127.0.0.1:3000`.
- The default workspace is `~/ddash-workspace`.
- The launcher exits after starting the container. Data and shell-history volumes persist.
- Use `docker logs -f devcontainer-dashboard` to follow logs; Ctrl+C only exits the log viewer.
- Use `--image ghcr.io/axelthas/devcontainer-dashboard:TAG` to select another published tag.

Published images do not automatically include unmerged branch changes. Use `--build`
when testing this branch.

### Automatic restart

Both launcher modes use Docker's `always` restart policy by default. The dashboard
restarts after it exits and starts again whenever the Docker daemon starts. Docker
must itself be configured to start at host boot.

Use `docker stop devcontainer-dashboard` to stop the registry instance temporarily.
It stays stopped until you run `docker start devcontainer-dashboard` or restart
Docker. To keep it stopped across Docker restarts, first run
`docker update --restart=no devcontainer-dashboard`, then stop it.
For build instances, use the container name printed by the launcher.

Do not rerun the launcher to resume an existing instance; use `docker start` instead.
Existing containers do not acquire this policy from a launcher update. For a retained
container, apply it with `docker update --restart=always CONTAINER_NAME`.
Older registry containers launched with `--rm` must be recreated without `--rm`;
preserve their named volumes.

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

### Give ClickUp Brain access to selected containers

Add `--brain` to enable the MCP listener on host loopback. For public access from
ClickUp, add `--brain-funnel` to your Tailscale launch command:

```bash
bash scripts/run-dashboard.sh --build \
  --workspace "$HOME/git.workspaces" \
  --tailscale-socket /var/run/tailscale/tailscaled.sock \
  --origin https://YOUR-NODE.YOUR-TAILNET.ts.net \
  --brain-funnel
```

Replace the example hostname with your actual node hostname. Keep your existing
workspace and Tailscale options. `--brain-funnel` implies `--brain`; no env file or
separate `tailscale funnel` command is needed. Tailscale HTTPS, MagicDNS, and Funnel
permission must already be enabled. The dashboard does not change tailnet policy.

- The launcher creates/reuses a private token in the retained data volume.
- Get it with `docker exec <dashboard-container> cat /data/brain-mcp-token`.
- Copy the public `/mcp` URL from the **Brain** panel into your ClickUp MCP connection.
- Set its header to `Authorization: Bearer <token>`.
- Select **Grant Brain** on each running container that Brain may use.
- Review the container user, mounts, credentials and network reach before granting.

The default public Funnel port is `10000`, outside the default service allocation
range. Use `--brain-port N` to change the local port, or `--brain-funnel-port N` to
select a permitted public port (`443`, `8443`, or `10000`). Conflicts are refused.
Only MCP is made public, never the dashboard. All MCP requests require the token.

Use `--brain-token-file /absolute/host/path` for a stable, operator-readable token
file mounted read-only. Each new `--build` instance otherwise gets its own data
volume and token. A restart of the same container reuses its token.

The Brain split pane groups commands by container and shows each command's goal and
output. On mobile, open the Brain tab. A terminal opens only when you request it.
Select **Take over** to type and **Hand back to Brain** when you are done. Brain
cannot type into or cancel a command while you have control, but it can read
everything shown in the terminal. Closing the tab does not stop the command.

The header shows **Brain disabled** with setup instructions when MCP is off.
See the [Brain access specification](specification/feature_brain_access/feature_specification_brain_access.md)
for ownership cleanup, crash recovery, limits and trust boundaries.

## Work with a devcontainer

Each devcontainer row and card has three controls. Each control has one job.

| Control       | Job                      | Items                                                                                   |
| ------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| **Open with** | Work in the devcontainer | VS Code, Terminal, OpenCode TUI, OpenChamber                                            |
| **Services**  | Open a published service | Every published port, for example OpenChamber and noVNC                                 |
| **⋯**         | Change wiring and state  | Connect to network…, Disconnect…, Restart or Start, Stop, Rebuild and restart…, Delete… |

**Open with** has the same items, in the same order, as the menu of a local workspace.

- When the container runs, the items open inside the container. **Terminal** opens a
  Zsh login shell (`zsh -l`) in the container workspace folder. Zsh must be installed in
  the container; the dashboard does not install it or silently fall back to Bash.
  **OpenCode TUI** runs
  `opencode` in the terminal drawer, in the same folder. If the container workspace folder
  is unknown, **OpenCode TUI** is disabled. If `opencode` is not installed in the
  container, the terminal shows a message. The dashboard does not install it.
  **OpenChamber** opens the container's OpenChamber service. If the container does not
  publish port 3000, the item is disabled.
- When the container is stopped, the menu shows "Container stopped: host folder". The
  items then open the local workspace folder on the host. They do not start the container.
  Use **Start** to start it.

### Remote user

**Terminal** and **OpenCode TUI** run as the remote user of the devcontainer, as VS Code
does. The dashboard reads the user from the `devcontainer.metadata` label that the Dev
Containers CLI writes on the container. The label contains the image metadata, the
Features, and `devcontainer.json`. A later entry overrides an earlier one.

1. The dashboard uses the last `remoteUser`.
2. If no entry sets `remoteUser`, the dashboard uses the last `containerUser`.
3. If no entry sets either property, the container's default user applies.

Before validating the selected user, the dashboard resolves `${localEnv:VAR}` from its
own server environment. We assume this environment is close enough to the host
environment. For example, `"remoteUser": "${localEnv:USER}"` uses the dashboard's `USER`.
`${localEnv:VAR:default}` supplies a default when the variable is unset (not when it is
set to an empty string). Multiple tokens and literal text can form the user value.
Substitution is literal, happens once, and does not run a shell.

If a variable is missing without a default, or the result is not a plain user name or
user ID, **Terminal** and **OpenCode TUI** are disabled. The dashboard never uses a
different user instead. Errors do not include substituted environment values.
Make the required host variables available in the dashboard environment. Changes to
that environment require restarting the dashboard. The dashboard does not apply
`remoteEnv`.

### Details

The list view shows **Services** as a menu. The icons on the button show which services
the container publishes. The grid view keeps the service buttons on each card.

Expand a row with its chevron to see:

- The local folder, container folder, configuration, and image of the container.
- The remote user and the metadata property that sets it.
- The port mapping: each container port and the host port that publishes it.
- The exact **Terminal** and **OpenCode TUI** commands, with a copy button. The commands
  run when the container is running.
- The networks of the container, with each address and alias, and a **Connect…** button.

The **Terminal** and **OpenCode TUI** menu items also show the command as a tooltip.

## Connect a devcontainer to a sandbox network

Connect a running devcontainer to an existing Docker network, for example the network of
a Polaris sandbox. This replaces `dev_connect_myself_to_docker_network.sh` and its VS Code
tasks. The dashboard server calls the Docker API. Nothing runs `docker` or `sudo` inside
the container.

Open the network drawer from one of these places:

- **⋯** > **Connect to network…** on a devcontainer row or card.
- **Connect…** in the expanded details of a devcontainer row.
- The network chip on a row: **Change address or alias…**.
- A **Join** chip, when `devcontainer.json` declares a network.
- **Docker Services**: expand a Compose group, select a network, then choose
  **Connect devcontainer** or **Stand in** on a free node seat.

In the drawer:

1. Select a network. The drawer lists existing user-defined networks only. The dashboard
   never creates a network.
2. Select how to join:
   - **Stand in for a node** takes the hostname and the address of a seat. A seat is free
     when its sandbox node is stopped.
   - **Any free address** lets Docker assign an address.
   - **Custom** takes an address and an alias that you enter.
3. Select the wiring options:
   - **Make it the only network** disconnects the other networks after the connect. It is
     off by default, so existing connections stay.
   - **Set the container hostname** runs `hostname` as root in the container. This needs
     `CAP_SYS_ADMIN`. If it fails, the drawer says so; the network alias still works.
   - **Offer to reconnect after a rebuild** saves the connection in this browser.
4. Read the Docker calls under the form, then select **Connect**.

A devcontainer can connect to several networks, one at a time. A Compose project can have
several networks, and a network can belong to several projects.

Rules:

- An address that a running container or another devcontainer holds is refused before
  anything runs. The message names the holder.
- The dashboard connects first and disconnects after. A failed step never leaves the
  container without a network. Leaving the last network connects `bridge` first.
- **Disconnect** asks first and shows the Docker calls.
- A rebuild makes a new container without the networks. The row then shows a
  **Reconnect** chip for each saved connection. The dashboard never reconnects by itself.
  If the saved address is taken, the drawer opens on that network.

Seats come from two sources:

- The containers of the sandbox on that network, running or stopped. A stopped container
  keeps its static address. The seat name is the first alias, else the Compose service.
- The `devcontainer.json` of the project, read from the `devcontainer.metadata` label:

```jsonc
"customizations": {
	"devcontainer-dashboard": {
		"networks": [
			{
				"network": "keflavik_oplan",
				"seats": [{ "hostname": "sim-pilot-1", "ip": "192.168.103.140" }]
			}
		]
	}
}
```

The dashboard skips invalid networks and seats in this declaration. A change takes effect
after **Rebuild and restart…**, because the label is written when the container is created.

## Sandbox versions and removal

The Compose sandbox panel has a **Version** field. Enter one tag, or focus the field to list
registry tags. The tag replaces the tag of every registry service (`image:` without `build:`).
Build services do not change. Empty means the image references in the Compose files.

- DevHarbour writes a managed override file outside the repository (`COMPOSE_OVERRIDE_DIR`,
  default `/data/compose-overrides`) and passes it as the last `--file`. Tracked files never change.
- **Pull** runs `compose pull --ignore-buildable`. **Pull and start** pulls, then starts when Pull succeeds.
- **Start** runs `compose up --detach --pull never`. Start never pulls. It is disabled when a
  selected registry image is not on this host.
- Tag listing uses the Docker credentials of the dashboard runtime (`auths`, `credHelpers`,
  `credsStore` in `$DOCKER_CONFIG/config.json`). Manual entry works when listing is refused.
- The Docker Services line shows the live version: the `devcontainer-dashboard.sandbox.tag`
  label, else the image tag. Different tags show `mixed`; untagged images show `latest`.

**Remove sandbox…** (Compose panel or Docker Services line) previews the containers and
networks to remove. Removal keeps volumes, images, source files, and every project network
that a container outside the project is attached to. A changed resource set after the preview
is refused; review it again.

## Rebuild an existing devcontainer

Use **Restart** in the container's **⋯** menu to restart the same container without
rebuilding its image or applying changed devcontainer configuration.

Use **Rebuild and restart…** in the container's **⋯** menu, in either the devcontainer
grid or list, when build inputs or configuration change:

1. Save changes to the Dockerfile or devcontainer configuration.
2. Open **⋯** on the intended container.
3. Select **Rebuild and restart…**.
4. Read the replacement warning.
5. Confirm the rebuild.
6. Follow the output in the build terminal.

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
