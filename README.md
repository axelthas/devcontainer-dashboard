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
