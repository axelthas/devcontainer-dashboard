# Devcontainer Dashboard

Devcontainer Dashboard is a SvelteKit application for discovering, inspecting, and controlling local Docker containers that belong to devcontainer or sandbox workflows. It combines container lifecycle actions, local workspace discovery, bootstrap tooling, and an embedded terminal in one dashboard.

The app is designed for a local operator running against a Docker socket and a workspace tree mounted under a known root. It is optimized for devcontainers, repo-based workspace layouts, and bootstrap flows that clone or update repositories inside a shared workspace volume.

## Features

- Shows running and stopped containers with exposed ports, devcontainer metadata, and compose grouping.
- Discovers local workspaces and their repositories from the workspace root on disk.
- Surfaces git branch and tag state for repos and tracks devcontainer build sessions.
- Supports bootstrap presets, provider metadata, pull, checkout, and run workflows.
- Provides an integrated terminal over WebSocket for interactive container and workspace operations.
- Polls container state from the server while rendering the initial dashboard from SSR data.

## Quick Start

### Prerequisites

- Node.js 22 or newer.
- Docker with access to the local Docker socket.
- A workspace tree mounted at the configured workspace root.
- Optional bootstrap and preset JSON files under the configured data directory.

### Install and run

```bash
npm install
DASHBOARD_PASSWORD='choose-a-strong-password' npm run dev
```

For production builds:

```bash
npm run build
npm run build:server
DASHBOARD_PASSWORD='choose-a-strong-password' npm start
```

`npm start` runs `build/server.js`, the custom HTTP and terminal WebSocket server. `npm run preview` is only a Vite preview and does not support terminal upgrades. Do not use it for production or terminal integration tests.

Useful checks:

```bash
npm run check
npm run lint
npm run test:deployment
npm run test:unit
npm run test:unit -- --run
npm run test:e2e
npm run test
```

### Containerized run

The repository includes a Docker image and a compose file for local deployment. The compose setup mounts the Docker socket, the workspace tree, and a data volume for presets and bootstrap provider metadata.

The fastest way to get the dashboard running is the bundled setup script:

```bash
curl -sL https://raw.githubusercontent.com/axelthas/devcontainer-dashboard/main/scripts/run-dashboard-compose.sh | bash
```

The script prompts for a workspace directory (defaults to `~/ddash-workspace`), a dashboard password using hidden input, and whether to enable the TernDev dev-bootstrap hook. It then writes a parameterized `docker-compose.yml` to `~/.config/devcontainer-dashboard/`, pulls the latest image, and starts the stack in the foreground. The literal password is not written to that file. Press Ctrl+C to stop.

To use the checked-in Compose file:

```bash
export DASHBOARD_PASSWORD='choose-a-strong-password'
export WORKSPACE_ROOT="$HOME/ddash-workspace"
mkdir -p "$WORKSPACE_ROOT"
docker compose up -d --wait
```

Both Compose paths and the direct Docker installer publish `127.0.0.1:3000` by default. For explicit remote access, set `DASHBOARD_BIND_ADDRESS` to a host interface address, or `0.0.0.0` for all IPv4 interfaces, before running Compose or the installer. This exposes full operator access. Use the HTTPS and reverse-proxy controls described below.

## Architecture

The dashboard is built with SvelteKit and runs with a custom Node server entry point so the HTTP server can also host the terminal WebSocket upgrade path.

Server-side rendering loads the initial container and workspace state. The client then polls the container API for fresh data so the page stays responsive without a full reload.

The main server responsibilities are split across the app, Docker helpers, workspace discovery, git helpers, and bootstrap/devcontainer build session tracking under src/lib/server.

## Environment Variables

| Variable                 | Default                        | Purpose                                                               |
| ------------------------ | ------------------------------ | --------------------------------------------------------------------- |
| DASHBOARD_PASSWORD       | required                       | Shared password required to access the dashboard                      |
| WORKSPACE_ROOT           | /workspaces                    | Root directory scanned for local workspace discovery and repo actions |
| HOST_HOSTNAME            | os.hostname()                  | Hostname displayed in the dashboard header                            |
| VSCODE_SSH_HOST          | empty                          | SSH host used when building VS Code remote URIs                        |
| PRESETS_FILE             | /data/presets.json              | JSON file containing bootstrap presets                                |
| BOOTSTRAP_PROVIDERS_FILE | /data/bootstrap-providers.json | JSON file containing bootstrap provider definitions                   |
| BUILD_LOG_DIR            | /data/build-logs                | Directory for logs of failed devcontainer builds and bootstrap runs   |
| PORT                     | 3000                           | Port used by the custom Node server                                   |
| DASHBOARD_BIND_ADDRESS   | 127.0.0.1                      | Host publication address for Compose and installer scripts            |
| ORIGIN                   | empty                          | Public URL of the dashboard behind a reverse proxy                    |
| PROTOCOL_HEADER          | empty                          | Trusted proxy header that carries the original protocol               |
| ADDRESS_HEADER           | empty                          | Trusted proxy header that carries the client IP address               |
| XFF_DEPTH                | 1                              | Number of trusted proxies when ADDRESS_HEADER is x-forwarded-for      |

`DASHBOARD_PASSWORD` must be non-empty. Development and production startup fail closed when it is absent. A successful login creates an opaque in-memory session and an `HttpOnly`, `SameSite=Strict` cookie that lasts until the browser session ends. Logout, process restart, or password rotation invalidates the session.

All dashboard pages, API routes, service views, and terminal WebSocket connections require the session. The configured password is removed from integrated-terminal environments. The login endpoint, required static assets, and the production readiness endpoint are public application resources.

## Run Logs

A terminal closes when its process exits. A failed devcontainer build or bootstrap run keeps its output as a log in `BUILD_LOG_DIR`, so you can view or download it from the Local Workspaces section later, also after a restart. A cancelled run (the Cancel button, Ctrl+C, or a closed terminal) and a successful run keep no log. Retry or Dismiss deletes the log, and logs are deleted after 7 days. If the directory is not writable, the log stays in memory until the dashboard restarts.

A log can contain secrets that a build or bootstrap script prints. Logs are only available to signed-in users, but they stay on disk until they are deleted.

## Routes

| Route                         | Purpose                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| /                             | Main dashboard with SSR-loaded containers and workspaces             |
| /service                      | Service iframe viewer opened from the dashboard                      |
| /demo/playwright              | Playwright test target page                                          |
| /healthz                      | Public production application readiness (GET or HEAD)                 |
| /api/containers               | Lists all visible containers and their port mappings                 |
| /api/containers/[id]/[action] | Starts, stops, restarts, or deletes a container                       |
| /api/presets                  | Returns bootstrap presets                                            |
| /api/workspaces (GET, DELETE) | Returns merged workspace and build state or deletes a workspace path |
| /api/bootstrap                | Returns bootstrap provider installation and branch metadata          |
| /api/bootstrap/providers      | Returns configured bootstrap providers and fallback provider info    |
| /api/bootstrap/run            | Starts, stops, or dismisses a bootstrap run                          |
| /api/bootstrap/pull           | Pulls the active bootstrap provider repository                       |
| /api/bootstrap/checkout       | Checks out a branch in the active bootstrap provider repository      |
| /api/repos/branches           | Returns branches, tags, and current ref information for a repository |
| /api/repos/checkout           | Checks out a branch or tag in a repository                           |
| /api/devcontainer/build       | Starts, cancels, or dismisses a devcontainer build                   |
| /api/run-logs/[id]            | Returns the kept log of a failed run; add ?download for plain text   |
| /api/terminal                 | WebSocket terminal sessions                                          |

## Deployment

The production image is built in two stages. The build stage installs native dependencies needed by node-pty, runs the SvelteKit build, and compiles the custom server entry point. The runtime stage installs git, openssh-client, and the devcontainer CLI before starting the entrypoint script.

The default Docker Compose setup binds host loopback port 3000, mounts the Docker socket, and maps a host workspace directory into the container so the dashboard can discover repos on disk.

### Build and run the current branch with one script

From your checkout, run:

```bash
bash scripts/run-production.sh
```

The script builds the current working tree with Docker Buildx and loads the final production image locally. It includes local changes allowed by the Docker build context. It does not fetch source, switch branches, change package versions, publish images, or use Vite. It prints the source branch, commit, and whether the checkout has local changes. No host Node or npm installation is required.

It prompts for a password unless `DASHBOARD_PASSWORD` is set. It starts a new, uniquely named test container on `127.0.0.1:3001`, waits for the image healthcheck, and checks readiness and unauthenticated API rejection inside the container. It then prints the browser URL, logs command, stop/resume commands, and retained test volume names. Log in and check the terminal manually. These startup checks do not replace the login and terminal smoke tests.

Options:

```bash
bash scripts/run-production.sh \
  --workspace /absolute/path/shared/with/docker/host \
  --socket /var/run/docker.sock \
  --port 3002 \
  --platform linux/amd64
```

Omit `--platform` to use your builder's default. An ARM host needs emulation to build and run `linux/amd64`. The workspace defaults to `WORKSPACE_ROOT` or `~/ddash-production-workspace`. The socket defaults to `DOCKER_SOCKET` or `/var/run/docker.sock`. Paths with spaces are supported; paths with commas are not. Inside a devcontainer, use workspace and socket paths available on the Docker host, not paths private to the devcontainer. See `bash scripts/run-production.sh --help` for environment overrides.

Each invocation builds again and creates a new container and separate named data volumes. Existing containers are never stopped or removed automatically. To run two tests simultaneously, choose different ports. Containers and volumes remain after success or failure for inspection; the script prints the commands to manage its container. Remove only test resources you no longer need. The test still has full access to the mounted Docker daemon and its containers.

Run the script's mocked regression tests without Docker:

```bash
node --test scripts/tests/run-production.test.mjs
```

The script follows the Dockerfile build path used by the release workflow, with `--load` instead of a registry push. The manual procedure below explains release-version and platform differences and shows the individual commands.

### Secure access through Tailscale

Keep the dashboard's Docker port bound to `127.0.0.1`. Use Tailscale Serve on the Docker host to provide tailnet-only HTTPS and WebSocket proxying. Do not use Tailscale Funnel: Funnel publishes the service to the internet.

1. On the Docker host (not inside the devcontainer), check existing Serve configuration:

   ```bash
   tailscale serve status
   ```

   Do not replace another service on HTTPS port 443. These examples assume that port is available. Tailscale must be installed and connected to your tailnet on this host.

2. Point Serve at a running dashboard. For the runner's default host port:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:3001
   ```

   Keep the spaces between `serve`, `--bg`, and `--https=443`. Follow Tailscale's prompts to enable HTTPS certificates if needed. Record the HTTPS URL printed by Serve. `--bg` persists the Serve configuration across Tailscale and host restarts; it does not restart the dashboard container.

3. Set the dashboard's external origin to that exact URL, without a trailing slash. Replace the example hostname below with the hostname Serve printed:

   ```bash
   export ORIGIN='https://YOUR-HOST.YOUR-TAILNET.ts.net'
   bash scripts/run-production.sh --port 3002
   ```

   The runner passes the exported `ORIGIN` into the container with `--env ORIGIN`. It still publishes only on host loopback. Using port 3002 leaves an existing test on port 3001 untouched. Wait for the new container to become healthy.

   `ORIGIN` configures the external HTTPS origin used for login and secure cookies. It is a runtime setting, not a build argument. Setting it in your shell does not update an already-created container, and `docker restart` does not change container environment variables. Start a new container with the runner. For a manual `docker run`, include `--env ORIGIN` after exporting it. Use the HTTPS URL for login; a direct HTTP login on loopback is no longer the configured origin.

4. On the host, update Serve to point to the new container:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:3002
   tailscale serve status
   ```

   The browser connection uses HTTPS/WSS. Serve terminates TLS and proxies HTTP/WebSocket traffic over host loopback to the production server. Do not bind Docker to `0.0.0.0` or install TLS certificates in the image.

5. Restrict access to this host's TCP 443 to your user or an approved operator group in your tailnet access policy. Review existing broad grants or ACL rules too: adding a narrower rule does not cancel a broader allow rule.

   Keep `DASHBOARD_PASSWORD` enabled. Tailscale controls network access, but the dashboard does not map Tailscale identity to application roles. Every signed-in operator has full Docker and terminal access. With only `ORIGIN` configured, login throttling is shared by clients seen through the proxy; this setup does not configure per-client forwarded-address trust.

6. From another device connected to your tailnet, open the HTTPS URL printed by Serve. Log in and open a terminal. Verify terminal output and check that the browser shows a secure connection. Confirm that an unapproved tailnet device and a device disconnected from the tailnet cannot access the dashboard.

To disable this Serve listener without resetting unrelated Serve configuration:

```bash
tailscale serve --bg --https=443 off
```

The dashboard container remains running on loopback. Stop it separately using the command printed by the runner. The script does not configure Tailscale or change tailnet access policies.

See the [Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve) for HTTPS prerequisites, background operation, and listener management.

### Build and test the production image manually

Use this procedure to test local source changes in the production image, without publishing an image or starting the development server. Run these commands in Bash from the repository root on the Docker host. You need Docker with Buildx, access to a local Docker daemon, and internet access for the image build. You do not need Node or npm on the host: the Dockerfile installs dependencies and builds both application outputs.

1. Check out the source revision you want to test. For the issue #13 fixes:

   ```bash
   git fetch origin
   git switch fix/13-production-startup
   git pull --ff-only
   git rev-parse HEAD
   ```

2. Build the final production image and load it into the local Docker image store:

   ```bash
   docker buildx build \
     --load \
     --progress=plain \
     --tag devcontainer-dashboard:issue-13 \
     .
   ```

   This uses the same root Dockerfile and repository build context as `.github/workflows/publish.yml`. It builds the final runtime stage, not only the builder stage. `--load` replaces CI's registry push so you can run the image locally. Do not run `npm run build` or `npm run preview` on the host first.

   The release workflow checks out `main` and runs `npm version VERSION --no-git-tag-version --allow-same-version` before building. It also adds registry tags, OCI metadata labels, and GitHub Actions cache settings. Those publication details are not required to exercise the runtime. To reproduce a particular release's version preparation, run that `npm version` command with its release version in a disposable checkout before building; it modifies the package files and requires npm on the host. The workflow currently builds `main`, not the release tag, so record the source commit as well as the version. The workflow builds and publishes the image; it does not run the container smoke test.

   By default, the local builder selects its own platform. Add `--platform linux/amd64` when you need the architecture used by the workflow's standard `ubuntu-latest` runner. An ARM host needs emulation for that build and run. This reproduces the build procedure, not a byte-identical image: the Dockerfile downloads unpinned external tools.

3. Configure a test password and workspace:

   ```bash
   read -r -s -p 'Test dashboard password: ' DASHBOARD_PASSWORD
   printf '\n'
   export DASHBOARD_PASSWORD
   export WORKSPACE_ROOT="$HOME/ddash-issue13-workspace"
   export DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
   mkdir -p "$WORKSPACE_ROOT"
   ```

   Use a non-empty password. For rootless Docker, set `DOCKER_SOCKET` to the host daemon's socket path. The container path remains `/var/run/docker.sock`. `WORKSPACE_ROOT` must be an absolute path that exists on the Docker host; mounting it at the same path inside the container preserves devcontainer path handling. If you run these commands inside a devcontainer, use a workspace path shared with the Docker host. A directory that exists only inside your current devcontainer is not a valid host bind source.

4. Start the image with a separate container name, test data volumes, and loopback port 3001:

   ```bash
   docker run --detach \
     --name ddash-issue13 \
     --publish 127.0.0.1:3001:3000 \
     --env DASHBOARD_PASSWORD \
     --env WORKSPACE_ROOT \
     --mount "type=bind,source=$DOCKER_SOCKET,target=/var/run/docker.sock" \
     --mount "type=bind,source=$WORKSPACE_ROOT,target=$WORKSPACE_ROOT" \
     --volume ddash_issue13_data:/data \
     --volume ddash_issue13_zsh:/home/ddash/.zsh_data \
     devcontainer-dashboard:issue-13
   ```

   This starts the image's normal entrypoint and compiled HTTP/WebSocket server. It does not use Vite, replace the entrypoint, pull `latest`, or run the optional TernDev bootstrap hook. The Docker socket grants control of the host daemon; use a trusted development machine. Test volumes separate dashboard data, not Docker containers: the dashboard can still see and control containers on that daemon.

5. Check startup and readiness:

   ```bash
   docker logs ddash-issue13
   docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' ddash-issue13
   curl --fail --show-error http://127.0.0.1:3001/healthz
   curl --silent --output /dev/null --write-out '%{http_code}\n' \
     http://127.0.0.1:3001/api/containers
   ```

   Wait for health status `healthy`; the first probe can take about 30 seconds. The readiness response must be `{"status":"ready"}`. The unauthenticated containers request must return `401`. If the container exits or becomes unhealthy, inspect its logs and probe output:

   ```bash
   docker inspect --format '{{json .State.Health}}' ddash-issue13
   ```

6. Open `http://127.0.0.1:3001` in your browser. Log in with the test password. Check container discovery. Open a terminal and run `printf 'production-terminal-ok\n'`. This verifies the production WebSocket and PTY path, which a Vite preview does not provide. If the Docker host is remote, use an SSH tunnel to its loopback port instead of publishing on all interfaces.

7. Stop the test when finished:

   ```bash
   docker stop ddash-issue13
   ```

   Resume the same test with `docker start ddash-issue13`. To replace it after another build, remove only this stopped test container with `docker rm ddash-issue13`, then repeat the run command. The two named test volumes remain for reuse. Remove `ddash_issue13_data` and `ddash_issue13_zsh` only when you intentionally want to discard that test's saved data.

### Socket and readiness policy

The container requires a Unix socket at `/var/run/docker.sock`. Mount a rootless or alternate host Docker socket at this same container path. Startup reads the GID from that path, creates a group if necessary, adds `ddash` to it, and checks read/write access using the server's group credentials. A missing socket, inaccessible socket, or failed group setup stops startup with an `[entrypoint] ERROR` diagnostic. The entrypoint does not change host socket ownership or permissions. Hooks run only after these checks and password validation.

`GET /healthz` returns only `{"status":"ready"}` after password configuration, compiled handler initialization, and server startup. `HEAD /healthz` returns the same status without a body. The image healthcheck probes this endpoint. A failed or unstarted application cannot pass the probe. Readiness is application readiness, not a Docker daemon ping or a workspace scan. A later Docker daemon failure can make operations fail while the application remains healthy.

### Regression checks

```bash
npm run test:deployment
npm run build
npm run build:server
npm run test:production
bash scripts/tests/container-smoke.sh
```

The deployment tests use mock privileged commands and a real temporary Unix socket. They do not change host groups or the Docker socket. The production smoke test checks the compiled server, required-password failure, readiness, login, rejected upgrades, authenticated upgrades, and PTY output.

The container smoke test requires Docker, Compose 2.24.4 or newer (`!override` support), Node 22, the `script` command from util-linux, and installed project dependencies (`npm ci`). It builds an image, renders both Compose paths, checks binding overrides, starts an isolated Compose project with a random loopback port, tests the application, and removes its own test containers and volumes on exit. It also checks fail-closed container startup and an unhealthy probe without an application. Run it only with a trusted local Docker daemon.

To test an already running disposable container, use `SMOKE_BASE_URL=http://127.0.0.1:PORT SMOKE_PASSWORD=... npm run test:production`. This creates a login session and a short-lived terminal command. Do not point it at a shared production instance. The external-server mode cannot verify that server's missing-password startup behavior.

The shared password is intended for localhost or another trusted private access path. It does not encrypt traffic and does not provide individual identities, roles, MFA, or audit history. Use HTTPS and preferably reverse-proxy OIDC/SSO before exposing the dashboard to a LAN or the public internet.

Behind a TLS reverse proxy, set `ORIGIN` or `PROTOCOL_HEADER=x-forwarded-proto`. Also set `ADDRESS_HEADER=x-forwarded-for` and set `XFF_DEPTH` to the number of trusted proxies. Without these variables, the server ignores forwarded headers and treats each request as plain HTTP. Login throttling then applies to the proxy address, so repeated failed logins from one user can lock out all users for one minute.

## References

- [Specification](specification/initial_specification.md)
- [Bootstrap feature spec](specification/feature_bootstrap/)
- [Implementation notes](tasks/)
