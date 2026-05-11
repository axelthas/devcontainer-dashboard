# Devcontainer Dashboard

A SvelteKit web dashboard for managing and monitoring local Docker containers. Displays devcontainers and sandbox services with their exposed ports, and provides start/stop/restart controls.

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
- **Deployment**: Multi-stage Docker build → `node build/index.js` on port 3000

### Route structure

| Route | Purpose |
|-------|---------|
| `/` | Main dashboard — SSR loads containers via `+page.server.ts`, polls `/api/containers` every 5s |
| `/service` | Iframe viewer for a service, opened from service buttons |
| `/demo/playwright` | Playwright test target page |
| `/api/containers` (GET) | Returns all containers with exposed ports as JSON |
| `/api/containers/[id]/[action]` (POST) | Executes `start`, `stop`, or `restart` on a container |

### Key files

| File | Purpose |
|------|---------|
| `src/lib/server/docker.ts` | Dockerode client singleton |
| `src/lib/types.ts` | `ContainerData` interface shared across server and client |
| `src/lib/components/` | `DevcontainerCard`, `SandboxRow`, `ServiceButton`, `ActionControls` |
| `src/routes/+page.server.ts` | SSR data loader — filters containers, builds port maps |
| `src/routes/api/containers/+server.ts` | REST endpoint duplicating page.server.ts logic for polling |

### Component conventions

- All components use Svelte 5 runes (`$props`, `$state`, `$derived`, `$effect`)
- Props are typed via `interface Props` and destructured from `$props()`
- Container actions call `fetch('/api/containers/{id}/{action}', { method: 'POST' })` then invoke `onRefresh` callback
- `ServiceButton` maps known container ports (6904, 4096, 9001, 8000, etc.) to labels/icons; unknown ports show as "Port N"

## Conventions

- **Dark/light theme**: Managed via `localStorage` key `devcontainer-dashboard-theme`, toggled in `+page.svelte`
- **No `$lib/server/` imports from client**: Server modules are in `src/lib/server/`, excluded from browser test projects
- **Test structure**: Two vitest projects configured in `vite.config.ts`:
  - `client` — browser-mode tests for `.svelte.{test,spec}.ts` files (uses `vitest-browser-svelte` + Playwright)
  - `server` — Node environment tests for `.{test,spec}.ts` files (excludes `.svelte.*` test files)
- **E2E tests**: Playwright files match `**/*.e2e.{ts,js}`

## Svelte MCP Tools

Use the Svelte MCP server for Svelte 5 and SvelteKit documentation:

1. **list-sections** — Call FIRST to discover available documentation sections
2. **get-documentation** — Fetch full docs for relevant sections found above
3. **svelte-autofixer** — MUST run on any Svelte code before finalizing; iterate until no issues remain
4. **playground-link** — Only after user confirms, and NEVER if code was written to project files

See [specification/specification.md](specification/specification.md) for the full product specification.
