# Devcontainer Dashboard

A SvelteKit web dashboard for managing and monitoring local Docker containers. Displays devcontainers and sandbox services with their exposed ports, and provides start/stop/restart controls with an integrated terminal.

## Build & Test

```bash
npm run dev              # Start dev server (vite, host 0.0.0.0)
npm run build            # Production build (adapter-node)
npm run preview          # Preview production build
npm run check            # svelte-check type checking
npm run lint             # prettier --check + eslint
npm run format           # prettier --write
npm run test:unit        # vitest (interactive watch mode)
npm run test:unit -- --run  # vitest single run
npm run test:e2e         # playwright (builds first, runs on port 4173)
npm run test             # unit + e2e combined
```

## Architecture

- **Framework**: SvelteKit with `@sveltejs/adapter-node`, Svelte 5 runes mode enforced
- **Styling**: Tailwind CSS v4 with Nord color palette via arbitrary hex values (e.g., `bg-[#2e3440]`)
- **Icons**: `lucide-svelte`
- **Docker**: `dockerode` connecting to `/var/run/docker.sock`
- **Terminal**: `node-pty` + `ws` WebSocket server on `/api/terminal`, rendered with `@xterm/xterm`
- **Deployment**: Multi-stage Docker build → `node build/index.js` on port 3000

### Environment variables

| Variable          | Default              | Purpose                                              |
| ----------------- | -------------------- | ---------------------------------------------------- |
| `WORKSPACE_ROOT`  | `/workspaces`        | Root directory scanned for local workspace discovery |
| `HOST_HOSTNAME`   | `os.hostname()`      | Displayed hostname in dashboard header               |
| `VSCODE_SSH_HOST` | (empty)              | SSH host for VS Code remote URIs                     |
| `PRESETS_FILE`    | `/data/presets.json` | Path to bootstrap presets JSON file                  |

### Route structure

| Route                                  | Purpose                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/`                                    | Main dashboard — SSR loads containers via `+page.server.ts`, polls `/api/containers` every 5s |
| `/service`                             | Iframe viewer for a service, opened from service buttons                                      |
| `/demo/playwright`                     | Playwright test target page                                                                   |
| `/api/containers` (GET)                | Returns all containers with exposed ports as JSON                                             |
| `/api/containers/[id]/[action]` (POST) | Executes `start`, `stop`, `restart`, or `delete` on a container                               |
| `/api/presets` (GET)                   | Returns bootstrap presets from `PRESETS_FILE`                                                 |
| `/api/workspaces` (GET)                | Returns discovered local workspaces                                                           |
| `/api/workspaces` (DELETE)             | Removes a workspace directory (requires `path` in body)                                       |
| `/api/terminal` (WebSocket)            | PTY terminal sessions via upgrade on the HTTP server                                          |

### Key files

| File                                   | Purpose                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/lib/server/docker.ts`             | Dockerode client singleton                                                                     |
| `src/lib/server/terminal.ts`           | WebSocket PTY server (attaches to Vite dev or production HTTP server)                          |
| `src/lib/server/workspaces.ts`         | Scans `WORKSPACE_ROOT` for task/repo pairs with `.devcontainer`                                |
| `src/lib/types.ts`                     | Shared interfaces: `ContainerData`, `LocalWorkspaceData`, `BootstrapPreset`, `TerminalSession` |
| `src/lib/portConfig.ts`                | Port-to-label/icon mapping for known services                                                  |
| `src/lib/components/`                  | UI components (see conventions below)                                                          |
| `src/routes/+page.server.ts`           | SSR data loader — filters containers, builds port maps                                         |
| `src/routes/api/containers/+server.ts` | REST endpoint duplicating page.server logic for client polling                                 |

### Component conventions

- All components use Svelte 5 runes (`$props`, `$state`, `$derived`, `$effect`)
- Props are typed via `interface Props` and destructured from `$props()`
- Container actions call `fetch('/api/containers/{id}/{action}', { method: 'POST' })` then invoke `onRefresh` callback
- Port labels/icons are defined in `src/lib/portConfig.ts` (`PORT_MAP`); unknown ports show as "Port N"

## Conventions

- **Dark/light theme**: Managed via `localStorage` key `devcontainer-dashboard-theme`, toggled in `+page.svelte`
- **No `$lib/server/` imports from client**: Server modules are in `src/lib/server/`, excluded from browser test projects
- **Nord palette only**: Use Nord hex values via Tailwind arbitrary values — no custom theme config
- **Native dependencies**: `node-pty` requires `build-essential python3` (dev) or `python3 make g++` (Alpine production)

## Testing

Two vitest projects configured in `vite.config.ts`:

- **`client`** — browser-mode tests for `.svelte.{test,spec}.ts` files (uses `vitest-browser-svelte` + Playwright chromium)
- **`server`** — Node environment tests for `.{test,spec}.ts` files (excludes `.svelte.*` test files)

Important:

- `expect.requireAssertions` is enabled — every test MUST contain at least one assertion
- E2E tests: Playwright files match `**/*.e2e.{ts,js}`
- Example tests in `src/lib/vitest-examples/` demonstrate both patterns

## Svelte MCP Tools

Use the Svelte MCP server for Svelte 5 and SvelteKit documentation:

1. **list-sections** — Call FIRST to discover available documentation sections
2. **get-documentation** — Fetch full docs for relevant sections found above
3. **svelte-autofixer** — MUST run on any Svelte code before finalizing; iterate until no issues remain
4. **playground-link** — Only after user confirms, and NEVER if code was written to project files

## Documentation

- [specification/initial_specification.md](specification/initial_specification.md) — Full product specification
- [specification/feature_bootstrap/](specification/feature_bootstrap/) — Bootstrap feature spec
- [tasks/](tasks/) — Implementation session notes and research
