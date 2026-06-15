# Devcontainer Dashboard Architecture

_Last updated: 2026-06-15_

This document is a living architecture reference for Devcontainer Dashboard. It follows the structure of the architecture.md template, but it is tailored to this repository’s actual runtime, data flow, and deployment model.

## 1. Project Structure

```text
.
├── README.md
├── ARCHITECTURE.md
├── Dockerfile
├── docker-compose.yml
├── package.json
├── playwright.config.ts
├── svelte.config.js
├── vite.config.ts
├── src/
│   ├── server.ts
│   ├── app.html
│   ├── lib/
│   │   ├── components/
│   │   ├── server/
│   │   ├── types.ts
│   │   └── portConfig.ts
│   └── routes/
│       ├── +layout.svelte
│       ├── +page.server.ts
│       ├── +page.svelte
│       ├── api/
│       │   ├── containers/
│       │   ├── presets/
│       │   ├── workspaces/
│       │   ├── bootstrap/
│       │   ├── repos/
│       │   └── devcontainer/build/
│       ├── demo/
│       └── service/
├── specification/
│   ├── initial_specification.md
│   └── feature_bootstrap/
└── tasks/
```

Key source areas:

- [src/routes/+page.server.ts](src/routes/+page.server.ts) loads the dashboard state for SSR.
- [src/server.ts](src/server.ts) is the production Node entry point and attaches the terminal WebSocket server.
- [src/lib/server/](src/lib/server) contains Docker, git, workspace, bootstrap, and session-tracking helpers.
- [src/routes/api/](src/routes/api) contains the HTTP surface used by the dashboard and polling client.

## 2. High-Level System Diagram

```text
[Docker Engine] <----> [Dashboard Server] <----> [Browser UI]
                           |   |   |
                           |   |   +--> /api/containers polling
                           |   |
                           |   +------> /api/workspaces, /api/bootstrap, /api/repos, /api/devcontainer/build
                           |
                           +----------> WebSocket terminal sessions on /api/terminal

[Workspace filesystem] <----> [Dashboard Server]
[Bootstrap/provider JSON] <--> [Dashboard Server]
[Git repositories] <---------> [Dashboard Server]
```

The dashboard server is the central orchestration layer. It reads Docker state, scans the workspace tree, queries git metadata, tracks bootstrap and build sessions in memory, and serves both SSR and client API requests.

## 3. Core Components

### 3.1 Frontend Application

Name: Dashboard UI

Description: The main SvelteKit user interface that displays containers, workspaces, bootstrap controls, and service launch actions. It renders initial state from SSR and then refreshes container state from the API.

Technologies: Svelte 5 runes, SvelteKit, Tailwind CSS v4, lucide-svelte, @xterm/xterm

Deployment: Served by the custom Node server produced from the SvelteKit build and the separate server compilation step.

### 3.2 Server Application

Name: Dashboard Server

Description: The HTTP server and route layer that powers SSR, API endpoints, and the terminal WebSocket upgrade path. It is the single place where Docker, git, filesystem, and in-memory session state are combined into UI-facing data.

Technologies: Node.js, SvelteKit, dockerode, ws, node-pty, native fs/path/os APIs

Deployment: Runs from [src/server.ts](src/server.ts) after `npm run build` and `npm run build:server`.

### 3.3 Docker Integration Layer

Name: Docker State Access

Description: Reads container state, exposed ports, image metadata, labels, and compose grouping from the local Docker daemon. It also executes container lifecycle actions such as start, stop, restart, and delete.

Technologies: dockerode, Docker socket (`/var/run/docker.sock`)

Deployment: Local runtime dependency. The containerized deployment mounts the Docker socket into the dashboard container.

### 3.4 Workspace Discovery Layer

Name: Workspace Scanner

Description: Scans the configured workspace root for task directories and git repositories, then merges those repositories with active bootstrap and devcontainer build sessions.

Technologies: Node filesystem APIs, git helpers, in-memory session stores

Deployment: Server-side only. The workspace root is controlled by `WORKSPACE_ROOT`.

### 3.5 Bootstrap and Build Session Tracking

Name: Bootstrap/Build Orchestrators

Description: Tracks bootstrap runs and devcontainer builds in memory so the UI can show progress immediately, even before a filesystem artifact appears.

Technologies: Node runtime state, filesystem reads for provider/preset JSON, git helpers, process execution wrappers

Deployment: Server-side only. Bootstrap provider metadata is loaded from `BOOTSTRAP_PROVIDERS_FILE` or the `~/.devbootstrap` fallback.

## 4. Data Stores

### 4.1 Docker Engine State

Name: Local Docker daemon

Type: System service / runtime state

Purpose: Holds the live state of containers, port bindings, labels, images, and compose grouping that the dashboard displays and controls.

Key Schemas/Collections: container IDs, container labels, port bindings, compose project labels, image names

### 4.2 Workspace Filesystem

Name: Workspace root

Type: Filesystem

Purpose: Stores task directories, repositories, `.devcontainer` definitions, `.solution-metadata.json`, and generated workspace content.

Key Schemas/Collections: directory tree, git repositories, devcontainer markers, solution metadata, bootstrap outputs

### 4.3 Bootstrap Provider JSON

Name: Bootstrap providers file

Type: JSON document

Purpose: Lists configured bootstrap providers and their commands. If absent, the server can fall back to `~/.devbootstrap`.

Key Schemas/Collections: provider id, provider name, repo path, update/rerun commands, optional metadata file

### 4.4 Presets JSON

Name: Bootstrap presets file

Type: JSON document

Purpose: Defines reusable bootstrap commands that the UI can render as presets.

Key Schemas/Collections: preset id, name, command, interactive flag, optional visible fields

### 4.5 In-Memory Session State

Name: Active bootstrap runs and devcontainer builds

Type: Process memory

Purpose: Keeps transient progress state visible across page loads and API polls until the operation completes or is removed.

Key Schemas/Collections: run/build id, status, startedAt timestamp, workspace/repo path, display name

## 5. External Integrations / APIs

### 5.1 Docker Engine API

Purpose: Container discovery, lifecycle actions, label inspection, and port metadata.

Integration Method: dockerode over the local Docker socket

### 5.2 Git

Purpose: Reads branches, tags, HEAD state, current tag state, and performs checkout/pull operations in local repositories.

Integration Method: Local git CLI helpers and repository inspection

### 5.3 Dev Containers CLI

Purpose: Supports build/start workspace actions that rely on the devcontainer toolchain.

Integration Method: Local CLI installed in the runtime container

### 5.4 WebSocket Terminal Transport

Purpose: Provides interactive terminal sessions to the browser UI.

Integration Method: `ws` upgrade on the same HTTP server that serves the dashboard

## 6. Deployment & Infrastructure

Cloud Provider: None. The application is designed for local or self-hosted deployment.

Key Services Used:

- SvelteKit application server
- Docker daemon access via bind mount
- Workspace directory mount
- Optional data volume for presets and bootstrap providers

CI/CD Pipeline: Standard repository checks and container build flows. The repo includes local scripts for type checking, linting, unit tests, E2E tests, and Docker builds.

Monitoring & Logging: Basic process logging to stdout/stderr. The custom server writes its startup port to the console.

Container runtime notes:

- The build image installs native packages required by `node-pty`.
- The runtime image installs `git`, `openssh-client`, and `@devcontainers/cli`.
- The server starts from the generated Node entry point rather than a standalone adapter binary.

## 7. Security Considerations

Authentication: None built into the application. It assumes access is controlled by the local network, Docker socket permissions, and the deployment environment.

Authorization: Route handlers validate container actions, workspace paths, and repository paths before mutating state. Workspace and repo endpoints reject paths outside `WORKSPACE_ROOT`.

Data Encryption: Not provided by the application itself. Transport security depends on the reverse proxy or host environment.

Key Security Practices:

- Restrict Docker socket access to trusted users.
- Validate path inputs before touching the filesystem.
- Avoid exposing the dashboard directly to untrusted networks without an upstream auth layer.
- Treat bootstrap provider commands and preset commands as operator-controlled inputs.

## 8. Development & Testing Environment

Local Setup:

- Install dependencies with `npm install`.
- Start the dev server with `npm run dev`.
- Use `npm run check`, `npm run lint`, `npm run test:unit`, and `npm run test:e2e` to verify changes.

Testing Frameworks: Vitest, Playwright, vitest-browser-svelte

Code Quality Tools: Prettier, ESLint, svelte-check

Relevant conventions:

- Svelte 5 runes are required across components.
- Client code should not import from `src/lib/server/`.
- `expect.requireAssertions` is enabled in tests, so every test needs at least one assertion.

## 9. Future Considerations / Roadmap

- Expand the bootstrap and repo metadata surfaces if additional provider types are introduced.
- Consider stronger operator authentication if the dashboard is ever exposed beyond a trusted local environment.
- Add more automated coverage around route contracts and workspace merge behavior as the API surface grows.
- Keep the server entry point and terminal upgrade flow aligned with SvelteKit and Node runtime changes.

## 10. Project Identification

Project Name: Devcontainer Dashboard

Repository URL: Local repository workspace

Primary Contact/Team: Repository owner / current maintainer

Date of Last Update: 2026-06-15

## 11. Glossary / Acronyms

Bootstrap preset: A reusable command definition that starts a workspace bootstrap flow.

Bootstrap provider: A repository-backed tool source that can be updated, rerun, or checked out.

Compose project: A Docker Compose group identified by the `com.docker.compose.project` label.

Devcontainer: A containerized development environment tied to a local repository path.

SSR: Server-side rendering.

WS: WebSocket.
