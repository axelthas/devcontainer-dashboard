# DevHarbour Architecture

_Last updated: 2026-08-11_

This document is a living architecture reference for DevHarbour (formerly Devcontainer Dashboard). It follows the structure of the architecture.md template, but it is tailored to this repository’s actual runtime, data flow, and deployment model.

New CLI and direct registry launches use the container name `devharbour`.
Isolated checkout builds default to unique `devharbour-local-*` names. Existing
saved configurations keep their name until an explicit save-only legacy migration
with `devharbour configure --instance-name devharbour`. This does not rename or
remove a Docker container. Both default names use the existing `dashboard_data`,
`ddash_zsh_data` and `dashboard_ai` volumes; reusing retained volumes needs the
normal adoption review, and volumes attached to another container are refused.
Repository/image references, configuration keys, saved browser settings and the
MCP server identifier remain compatible.

## 1. Project Structure

```text
.
├── README.md
├── ARCHITECTURE.md
├── Dockerfile
├── plugins/
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

The dashboard server is the central orchestration layer. It authenticates browser sessions, reads Docker state, scans the workspace tree, queries git metadata, tracks bootstrap and build sessions in memory, and serves both SSR and client API requests.

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

### 4.5 In-Memory Operation State

Name: Active bootstrap runs and devcontainer builds

Type: Process memory

Purpose: Keeps transient progress state visible across page loads and API polls until the operation completes or is removed.

Key Schemas/Collections: run/build id, status, startedAt timestamp, workspace/repo path, display name

### 4.6 Authentication Sessions

Name: Dashboard login sessions

Type: Process memory plus an `HttpOnly` browser-session cookie

Purpose: Exchanges the required shared `DASHBOARD_PASSWORD` for a random opaque token. Only a digest of each active token is retained by the server. Sessions are intentionally lost on process restart and are revoked on logout.

Key Schemas/Collections: session-token digest, per-client failed-login count, temporary lockout timestamp

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

Authentication: A required shared password is validated by [src/lib/server/auth.ts](src/lib/server/auth.ts). [src/hooks.server.ts](src/hooks.server.ts) protects rendered pages and HTTP APIs, while the terminal server independently validates the same session cookie and request origin before accepting a WebSocket upgrade. Login creates an opaque process-local session; the password is never stored in browser JavaScript or sent in a URL.

Authorization: Every authenticated user has full operator access. Route handlers additionally validate container actions, workspace paths, and repository paths before mutating state. Workspace and repo endpoints reject paths outside `WORKSPACE_ROOT`.

Data Encryption: Not provided by the application itself. Transport security depends on the reverse proxy or host environment.

Key Security Practices:

- Restrict Docker socket access to trusted users.
- Require a strong `DASHBOARD_PASSWORD`; startup fails closed when it is missing or empty.
- Keep the password out of terminal child-process environments, logs, URLs, and generated Compose files.
- Validate path inputs before touching the filesystem.
- Use HTTPS and preferably reverse-proxy OIDC/SSO for any access beyond localhost or another trusted private path. The shared password does not provide per-user identity, MFA, or auditing.
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

Project Name: DevHarbour

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

## Managed configuration Settings

The authenticated `/settings` page and `/api/settings` endpoint use
`src/lib/server/settings.ts` to invoke the fixed Python Settings bridge over
bounded stdin. `scripts/devharbour_settings.py` shares the host CLI's JSON Schema,
flock, no-Docker validation and atomic write contract. It returns only redacted
state. Credential and managed-environment replacement publishes a new private
input reference, keeping previous files for recovery.

Managed deployments mount the private configuration directory at its canonical
host path through `--managed-config` and `DEVHARBOUR_CONFIG`. Direct deployments
without this mount show Settings as unavailable. The config ownership label stays
based on the host path. Save changes desired state only; host `devharbour apply`
performs the existing reviewed replacement flow. Every current field is marked
Recreate. Live/per-build readers and an external apply helper are deferred.

## Reviewed browser apply

`POST /api/settings/apply` creates a private, expiring review and queues only its
explicitly approved candidate. `scripts/devharbour_apply.py` is an independent
one-shot Docker helper using the current immutable image. It calls the existing
Python CLI with a revision guard inside the config lock and an exact-container
precondition before replacement. Image preparation precedes stop/remove. The
CLI alone records last-applied state after readiness.

A private sibling `.apply.json` stores redacted progress outside the CLI lock,
so `GET /api/settings/apply` remains available during a build/replacement. The
requesting process is not responsible for completion. Sessions are process-local:
a new login is required after recreation. No automatic rollback is claimed.
The shared banner appears in desktop, mobile and Settings. Read-only Settings
reads use shared locks with a short bounded acquisition wait; writes and lifecycle
commands retain exclusive locks.
