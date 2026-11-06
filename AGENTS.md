# Devcontainer Dashboard

A SvelteKit web dashboard for managing and monitoring local Docker containers. Displays devcontainers and sandbox services with their exposed ports, and provides start/stop/restart controls with an integrated terminal.

## Build & Test

```bash
npm run dev              # Start dev server (vite, host 0.0.0.0)
npm run build            # Production build (adapter-node)
npm run build:server     # Compile the custom Node server entry point
npm start                # Start the built HTTP and terminal WebSocket server
npm run preview          # Vite preview only, no terminal WebSocket support
npm run check            # svelte-check type checking
npm run lint             # prettier --check + eslint
npm run format           # prettier --write
npm run test:deployment  # Entrypoint and deployment regressions (no Docker needed)
npm run test:production  # Built custom-server smoke test (build both outputs first)
npm run test:gateway     # Standalone service-gateway regressions (build both outputs first)
bash scripts/tests/container-smoke.sh # Build and test an isolated container deployment
npm run test:unit        # vitest (interactive watch mode)
npm run test:unit -- --run  # vitest single run
npm run test:e2e         # playwright (builds both outputs, runs npm start on port 4173)
npm run test             # deployment + unit + e2e combined
```

## Architecture

- **Framework**: SvelteKit with `@sveltejs/adapter-node`, Svelte 5 runes mode enforced project-wide
- **Styling**: Tailwind CSS v4 with Nord color palette via arbitrary hex values (e.g., `bg-[#2e3440]`)
- **Icons**: `lucide-svelte`
- **Docker**: `dockerode` connecting to `/var/run/docker.sock`
- **Terminal**: `node-pty` + `ws` WebSocket server on `/api/terminal`, rendered with `@xterm/xterm`
- **Authentication**: Required shared password creates opaque, process-local sessions; `src/hooks.server.ts` gates HTTP and `src/lib/server/terminal.ts` gates WebSocket upgrades
- **Deployment**: Multi-stage Docker build. The build image runs `npm run build && npm run build:server`; the runtime image starts the custom Node server on port 3000.
- **Server entry point**: `src/server.ts` creates the HTTP server, attaches the terminal WebSocket handler, and listens on `PORT`

### Environment variables

| Variable                   | Default                          | Purpose                                               |
| -------------------------- | -------------------------------- | ----------------------------------------------------- |
| `DASHBOARD_PASSWORD`       | required                         | Shared password used to create authenticated sessions |
| `WORKSPACE_ROOT`           | `/workspaces`                    | Root directory scanned for local workspace discovery  |
| `HOST_HOSTNAME`            | `os.hostname()`                  | Displayed hostname in dashboard header                |
| `VSCODE_SSH_HOST`          | (empty)                          | SSH host for VS Code remote URIs                      |
| `PRESETS_FILE`             | `/data/presets.json`             | Path to bootstrap presets JSON file                   |
| `BOOTSTRAP_PROVIDERS_FILE` | `/data/bootstrap-providers.json` | Path to bootstrap provider definitions                |
| `PORT`                     | `3000`                           | Port used by the custom server entry point            |
| `DASHBOARD_BIND_ADDRESS`   | `127.0.0.1`                      | Launcher publication address; pass `--bind-address`   |
| `SERVICE_PROXY_ENABLED`    | (empty)                          | Set to `1` to enable the opt-in service gateway       |
| `SERVICE_PROXY_HOST`       | (empty)                          | Operator-owned host route for gateway upstreams       |
| `SERVICE_PROXY_PORTS`      | (empty)                          | `port:http\|https\|off` policy overrides              |
| `SERVICE_SUBDOMAIN_BASE`   | (empty)                          | Node name that enables wildcard service subdomains    |
| `SERVICE_TLS_CERT_FILE`    | (empty)                          | Wildcard certificate PEM for service subdomains       |
| `SERVICE_TLS_KEY_FILE`     | (empty)                          | Wildcard private key PEM for service subdomains       |

### Runtime notes

- The dashboard SSR load in [src/routes/+page.server.ts](src/routes/+page.server.ts) is the authoritative entry for initial container and workspace data.
- The client polling endpoint is [src/routes/api/containers/+server.ts](src/routes/api/containers/+server.ts); keep its response shape aligned with the page load data.
- Workspace discovery lives in [src/lib/server/workspaces.ts](src/lib/server/workspaces.ts) and merges in-memory bootstrap and devcontainer build sessions.
- Bootstrap provider loading lives in [src/lib/server/bootstrap.ts](src/lib/server/bootstrap.ts), with a fallback to `~/.devbootstrap` if no providers file exists.
- Runtime startup fails when `DASHBOARD_PASSWORD` is empty. Sessions are in memory and end on logout, browser close, or process restart.
- Keep `DASHBOARD_PASSWORD` excluded from terminal child-process environments in [src/lib/server/terminal.ts](src/lib/server/terminal.ts).
- The service gateway is disabled unless `SERVICE_PROXY_ENABLED=1`. When enabled, [src/routes/service/+page.server.ts](src/routes/service/+page.server.ts) is the authoritative viewer contract: the server validates the container/port and picks the iframe target. Keep the client-side `src/lib/serviceTargets.ts` free of server imports.
- Wildcard service subdomains are disabled unless `SERVICE_SUBDOMAIN_BASE` is set. When enabled, the viewer prefers them over the path gateway, and [src/hooks.server.ts](src/hooks.server.ts) rejects same-site requests from service origins. See [tasks/TAILNET-SERVICE-SUBDOMAINS.md](tasks/TAILNET-SERVICE-SUBDOMAINS.md).
- Container startup also fails if `/var/run/docker.sock` is missing, inaccessible, or group setup fails. Do not change host socket permissions.
- `/healthz` is a public production-only application readiness probe with no sensitive state. It does not check Docker daemon availability.
- Use `npm start`, not Vite preview, for production and terminal integration checks.

### Route structure

| Route                                  | Purpose                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/`                                    | Main dashboard: SSR loads containers via `+page.server.ts`, polls `/api/containers` every 5s |
| `/service`                             | Identity-validated service viewer; SSR load decides the iframe target                        |
| `/service-proxy/[id]/[port]/`          | Opt-in authenticated streaming gateway to a running container web service                    |
| `https://<port>-<id>.<node>:8443/`     | Opt-in wildcard service subdomain on the shared TLS listener                                 |
| `/demo/playwright`                     | Playwright test target page                                                                  |
| `/healthz`                             | Public production readiness (GET or HEAD)                                                    |
| `/api/containers` (GET)                | Returns all containers with exposed ports as JSON                                            |
| `/api/containers/[id]/[action]` (POST) | Executes `start`, `stop`, `restart`, or `delete` on a container                              |
| `/api/presets` (GET)                   | Returns bootstrap presets from `PRESETS_FILE`                                                |
| `/api/workspaces` (GET, DELETE)        | Returns discovered local workspaces or removes a workspace directory with `path` in the body |
| `/api/bootstrap` (GET)                 | Returns active bootstrap provider install status, branches, and version                      |
| `/api/bootstrap/providers` (GET)       | Returns configured bootstrap providers and fallback provider info                            |
| `/api/bootstrap/run` (POST)            | Starts a bootstrap run for a preset or custom command                                        |
| `/api/bootstrap/pull` (POST)           | Pulls the active bootstrap provider repository                                               |
| `/api/bootstrap/checkout` (POST)       | Checks out a branch in the active bootstrap provider repository                              |
| `/api/repos/branches` (GET)            | Returns branches, tags, and current ref information for a repository path                    |
| `/api/repos/checkout` (POST)           | Checks out a branch or tag in a repository path                                              |
| `/api/devcontainer/build` (POST)       | Starts a devcontainer build session for a repository                                         |
| `/api/terminal` (WebSocket)            | PTY terminal sessions via upgrade on the HTTP server                                         |

### Key files

| File                                        | Purpose                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/lib/server/auth.ts`                    | Password validation, login throttling, opaque sessions, and cookie helpers                     |
| `src/lib/server/docker.ts`                  | Dockerode client singleton                                                                     |
| `src/lib/server/terminal.ts`                | WebSocket PTY server (attaches to Vite dev or production HTTP server)                          |
| `src/lib/server/workspaces.ts`              | Scans `WORKSPACE_ROOT` for task/repo pairs with `.devcontainer`                                |
| `src/lib/server/bootstrap.ts`               | Loads bootstrap providers and resolves the active provider                                     |
| `src/lib/server/bootstrapRuns.ts`           | Tracks bootstrap run sessions in memory                                                        |
| `src/lib/server/devcontainerBuilds.ts`      | Tracks active devcontainer build sessions in memory                                            |
| `src/lib/types.ts`                          | Shared interfaces: `ContainerData`, `LocalWorkspaceData`, `BootstrapPreset`, `TerminalSession` |
| `src/lib/portConfig.ts`                     | Port-to-label/icon mapping for known services                                                  |
| `src/lib/serviceTargets.ts`                 | Client-safe service identity, viewer hrefs, proxy paths, and embed profiles                    |
| `src/lib/server/serviceGateway.ts`          | Streaming gateway core: auth, origin checks, cookie scoping, redirects, upgrades               |
| `src/lib/server/serviceGatewayRuntime.ts`   | Docker/session wiring, opt-in flag, `SERVICE_PROXY_PORTS` policy, viewer target validation     |
| `src/lib/server/serviceSubdomains.ts`       | Service subdomain configuration and strict Host parsing                                        |
| `src/lib/server/serviceOriginAuth.ts`       | One-use launch tickets and per-origin service sessions                                         |
| `src/lib/server/serviceSubdomainGateway.ts` | Host routing, ticket exchange, session leases, and root-origin proxying                        |
| `src/lib/server/serviceSubdomainRuntime.ts` | Launch validation, the shared HTTPS listener, and certificate reload                           |
| `src/routes/service/+page.server.ts`        | Validated viewer contract; server decides the iframe target from live Docker state             |
| `src/lib/components/`                       | UI components (see conventions below)                                                          |
| `src/routes/+page.server.ts`                | SSR data loader: filters containers, builds port maps                                          |
| `src/routes/api/containers/+server.ts`      | REST endpoint duplicating page.server logic for client polling                                 |

### Component conventions

- All components use Svelte 5 runes (`$props`, `$state`, `$derived`, `$effect`) — never legacy `export let` or `$:` reactive statements
- Props are typed via `interface Props` and destructured from `$props()`
- Use `$derived` for computed values, `$derived.by(() => { ... })` for multi-line derivations
- Use `$effect` for side effects; return a cleanup function when needed
- Icons from `lucide-svelte` — import individually (e.g., `import { Play, Square } from 'lucide-svelte'`)
- Container actions call `fetch('/api/containers/{id}/{action}', { method: 'POST' })` then invoke `onRefresh` callback
- Port labels/icons are defined in `src/lib/portConfig.ts` (`PORT_MAP`); unknown ports show as "Port N"
- Keep client components free of direct `$lib/server/` imports.
- Prefer updating the relevant server module or route handler rather than duplicating logic in a component.

### API route conventions

- Export named handlers: `GET`, `POST`, `DELETE`, etc. typed as `RequestHandler`
- Import types from `./$types` (auto-generated by SvelteKit)
- Return responses with `json()` from `@sveltejs/kit`
- Throw errors with `error(statusCode, message)` from `@sveltejs/kit`
- Import the Docker singleton as `import docker from '$lib/server/docker'`
- Container actions are restricted to the allowlist: `start`, `stop`, `restart`, `delete`
- Container IDs are truncated to 12 chars on the client side
- Validate paths that reference the filesystem (e.g., workspace deletion): ensure they start with `WORKSPACE_ROOT + '/'` and normalize them to prevent traversal (e.g., `new URL('file://' + path).pathname`)

```typescript
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	// ...
	return json(data);
};

export const POST: RequestHandler = async ({ params, request }) => {
	// Validate input
	if (!valid) throw error(400, 'Invalid input');
	// Perform action
	return json({ success: true });
};
```

## Conventions

- **Dark/light theme**: Managed via `localStorage` key `devcontainer-dashboard-theme`, toggled in `+page.svelte`; support both modes using `dark:` variants
- **No `$lib/server/` imports from client**: Server modules are in `src/lib/server/`, excluded from browser test projects
- **Nord palette only**: Use Nord hex values via Tailwind arbitrary values, no custom theme config. Key colors: `#2e3440` (polar night), `#3b4252`, `#434c5e`, `#4c566a`, `#d8dee9` (snow storm), `#e5e9f0`, `#eceff4`, `#8fbcbb` (frost), `#88c0d0`, `#81a1c1`, `#5e81ac`
- **Native dependencies**: `node-pty` requires `build-essential python3` (dev) or `python3 make g++` (Alpine production)
- **Container metadata**: Compose projects are grouped by `com.docker.compose.project`, while devcontainers are identified from name and image heuristics plus the `devcontainer.local_folder` label.

## Testing

Two vitest projects configured in `vite.config.ts`:

- **`client`**: browser-mode tests for `.svelte.{test,spec}.ts` files (uses `vitest-browser-svelte` + Playwright chromium)
- **`server`**: Node environment tests for `.{test,spec}.ts` files (excludes `.svelte.*` test files)

Important:

- `expect.requireAssertions` is enabled: every test MUST contain at least one assertion
- E2E tests: Playwright files match `**/*.e2e.{ts,js}`
- Example tests in `src/lib/vitest-examples/` demonstrate both patterns
- When changing server routes, validate the request/response contract with a focused test if one already exists nearby.
- When changing Svelte components, run the Svelte MCP autofixer before finalizing and keep runes syntax consistent.
- `test:deployment` uses Node's test runner with mocked privileged commands and a real temporary Unix socket. It requires no npm dependencies.
- `test:production` exercises the compiled custom server, HTTP login, WebSocket authorization, and PTY output. `SMOKE_BASE_URL` targets a disposable external container.
- `test:gateway` runs disposable HTTP/upgrade regressions against the compiled gateway module in `build/lib/server/serviceGateway.js`; `GATEWAY_MODULE_URL` can point at an isolated transpiled build when project dependencies are unavailable. It also runs the subdomain regressions; `SERVICE_SUBDOMAIN_BUILD_DIR` points them at isolated transpiled modules.
- `container-smoke.sh` requires Docker, Node 22, util-linux `script`, and installed project dependencies. It cleans up only its isolated containers, volumes and test resources.

## Svelte MCP Tools

Use the Svelte MCP server for Svelte 5 and SvelteKit documentation:

1. **list-sections**: Call FIRST to discover available documentation sections
2. **get-documentation**: Fetch full docs for relevant sections found above
3. **svelte-autofixer**: MUST run on any Svelte code before finalizing; iterate until no issues remain
4. **playground-link**: Only after user confirms, and NEVER if code was written to project files

## Skills

Project skills live in `.opencode/skills/` and are invoked explicitly:

- **scaffold-feature**: Scaffolds a full vertical-slice feature (types, server module, API route, SSR loader, component, tests) following project conventions. Suggest invoking it with `@scaffold-feature` when asked to add a new feature, dashboard section, or API endpoint with UI.

## Authoritative Sources

- [specification/initial_specification.md](specification/initial_specification.md): Core product behavior and terminology
- [specification/feature_bootstrap/feature_specification_bootstrap.md](specification/feature_bootstrap/feature_specification_bootstrap.md): Bootstrap workflow details
- [src/lib/types.ts](src/lib/types.ts): Shared data models and session state shapes
- [src/routes/api/\*_/_.ts](src/routes/api): Route names, request validation, and response contracts
- [src/server.ts](src/server.ts): Production server entry point and PORT handling

## Documentation

- [specification/initial_specification.md](specification/initial_specification.md): Full product specification
- [specification/feature_bootstrap/](specification/feature_bootstrap/): Bootstrap feature spec
- [tasks/](tasks/): Implementation session notes and research
