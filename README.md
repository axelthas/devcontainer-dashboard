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

For production-style builds:

```bash
npm run build
npm run build:server
DASHBOARD_PASSWORD='choose-a-strong-password' npm run preview
```

Useful checks:

```bash
npm run check
npm run lint
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
| VSCODE_SSH_HOST          | empty                          | SSH host used when building VS Code remote URIs                       |
| PRESETS_FILE             | /data/presets.json             | JSON file containing bootstrap presets                                |
| BOOTSTRAP_PROVIDERS_FILE | /data/bootstrap-providers.json | JSON file containing bootstrap provider definitions                   |
| PORT                     | 3000                           | Port used by the custom Node server                                   |

`DASHBOARD_PASSWORD` must be non-empty. Development and production startup fail closed when it is absent. A successful login creates an opaque in-memory session and an `HttpOnly`, `SameSite=Strict` cookie that lasts until the browser session ends. Logout, process restart, or password rotation invalidates the session.

All dashboard pages, API routes, service views, and terminal WebSocket connections require the session. The configured password is removed from integrated-terminal environments. The login endpoint and required static assets are the only public application resources.

## Routes

| Route                         | Purpose                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| /                             | Main dashboard with SSR-loaded containers and workspaces             |
| /service                      | Service iframe viewer opened from the dashboard                      |
| /demo/playwright              | Playwright test target page                                          |
| /api/containers               | Lists all visible containers and their port mappings                 |
| /api/containers/[id]/[action] | Starts, stops, restarts, or deletes a container                      |
| /api/presets                  | Returns bootstrap presets                                            |
| /api/workspaces (GET, DELETE) | Returns merged workspace and build state or deletes a workspace path |
| /api/bootstrap                | Returns bootstrap provider installation and branch metadata          |
| /api/bootstrap/providers      | Returns configured bootstrap providers                               |
| /api/bootstrap/run            | Starts a bootstrap run                                               |
| /api/bootstrap/pull           | Pulls the active bootstrap provider repository                       |
| /api/bootstrap/checkout       | Checks out a branch in the active bootstrap provider repository      |
| /api/repos/branches           | Returns local branches, remote branches, and tags for a repository   |
| /api/repos/checkout           | Checks out a branch or tag in a repository                           |
| /api/devcontainer/build       | Starts a devcontainer build for a repository                         |
| /api/terminal                 | WebSocket terminal sessions                                          |

## Deployment

The production image is built in two stages. The build stage installs native dependencies needed by node-pty, runs the SvelteKit build, and compiles the custom server entry point. The runtime stage installs git, openssh-client, and the devcontainer CLI before starting the entrypoint script.

The default Docker Compose setup binds port 3000, mounts the Docker socket, and maps a host workspace directory into the container so the dashboard can discover repos on disk.

The shared password is intended for localhost or another trusted private access path. It does not encrypt traffic and does not provide individual identities, roles, MFA, or audit history. Use HTTPS and preferably reverse-proxy OIDC/SSO before exposing the dashboard to a LAN or the public internet.

## References

- [Specification](specification/initial_specification.md)
- [Bootstrap feature spec](specification/feature_bootstrap/feature_specification_bootstrap.md)
- [Implementation notes](tasks/)
