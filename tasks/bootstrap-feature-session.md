# Bootstrap Feature — Implementation Session Summary

This document summarises everything done in the implementation session for the bootstrap feature (branch `tasks/bootstrap-feature`).

---

## Feature Overview

Implemented the full bootstrap feature as specified in `specification/feature_bootstrap/feature_specification_bootstrap.md`. The goal was to add:

1. **Local Workspace Discovery** — scan a `WORKSPACE_ROOT` directory for task/repo pairs with devcontainer configs, show them in a new dashboard section.
2. **Bootstrap Presets** — saved commands (stored in a JSON file) that can be run in a terminal.
3. **Integrated Terminal Drawer** — bottom-anchored collapsible drawer with tabbed terminal sessions, backed by `node-pty` + WebSockets (`ws`), rendered in the browser with `@xterm/xterm`.

---

## New Dependencies

| Package | Purpose |
|---------|---------|
| `node-pty` | Pseudo-terminal spawning (native addon) |
| `ws` | WebSocket server (attaches to existing HTTP server) |
| `@xterm/xterm` | Browser terminal emulator |
| `@xterm/addon-fit` | Auto-fit xterm to container size |
| `@types/ws` | TypeScript types for ws |

Build tools required for `node-pty` native compilation:
- **Dockerfile** (production): `apk add --no-cache python3 make g++`
- **.devcontainer/Dockerfile** (dev): `apt-get install -y build-essential python3` added to the existing deps block

---

## New Files

### `src/lib/types.ts` — extended
Added interfaces:
```ts
RepositoryData    { name, path, hasDevcontainer, isRunning }
LocalWorkspaceData { id, name, path, repos: RepositoryData[] }
BootstrapPreset   { id, name, command }
TerminalSession   { id, name }
```

### `src/lib/server/workspaces.ts` *(new)*
Shared utility that scans `WORKSPACE_ROOT` (env var, default `/bootstrap_workspaces`) for task directories → git repos. Checks for `.devcontainer` folder and matches `devcontainer.local_folder` Docker labels to determine `isRunning`. Used by both the SSR page loader and the REST API endpoint.

### `src/lib/server/terminal.ts` *(new)*
WebSocket terminal backend. `attachTerminalServer(httpServer)` registers an `upgrade` event handler on the HTTP server, only intercepts `/api/terminal` requests (all other paths are passed through untouched — critical for Vite HMR). Spawns a `node-pty` shell per connection. Supports `command` and `cwd` query params; handles `resize` messages. 

**Key bug that was fixed**: originally called `socket.destroy()` on non-`/api/terminal` upgrades, which killed Vite's HMR WebSocket and caused constant page reloads. Changed to a plain `return`.

### `src/server.ts` *(new)*
Custom production entry point. Creates a `node:http` server, attaches the SvelteKit `handler` from `./handler.js`, calls `attachTerminalServer`, then listens on `PORT` (default `3000`). Replaces the default `build/index.js` startup.

### `tsconfig.server.json` *(new)*
Compiles `src/server.ts` + `src/lib/server/terminal.ts` → `build/` with `module: NodeNext`. Run via `npm run build:server`.

### `src/routes/api/workspaces/+server.ts` *(new)*
`GET /api/workspaces` — delegates to `loadWorkspaces()` from the shared server utility, returns JSON.

### `src/routes/api/presets/+server.ts` *(new)*
`GET` / `POST /api/presets` — JSON file storage at `PRESETS_FILE` env var (default `/data/presets.json`). POST upserts by id; uses `crypto.randomUUID()` for new entries.

### `src/lib/components/LocalWorkspaces.svelte` *(new)*
Section showing task workspaces and their repos. Receives `workspaces: LocalWorkspaceData[]` as a prop (loaded SSR — no client-side effect). Has a **Refresh button** (↺) that calls `/api/workspaces` on demand. Repos show: "No configuration" / "Active Above" badge / "Build & Start" button (opens a terminal tab running `devcontainer up --workspace-folder <path>`).

### `src/lib/components/BootstrapModal.svelte` *(new)*
Modal triggered by the "Run Bootstrap" header button. Preset dropdown + command input. "Save as Preset" POSTs to `/api/presets`. "Run in Terminal" calls the `onRunInTerminal(command, name)` callback.

### `src/lib/components/TerminalTab.svelte` *(new)*
Wraps a single `@xterm/xterm` instance + WebSocket connection. Uses Svelte 5 `{@attach}` pattern (not the legacy `use:` action) for DOM attachment. Connects to `ws(s)://host/api/terminal?sessionId=...&command=...&cwd=...`. Routes pty data → xterm write, xterm keystrokes → ws send. Handles resize via `ResizeObserver`. Nord colour theme. Dynamically imports xterm (SSR-safe).

### `src/lib/components/TerminalManager.svelte` *(new)*
Bottom-anchored collapsible drawer. Tab bar + content area. Props: `open`, `sessions`, `activeId`, `workspaceRoot`, `onToggle`, `onAddSession`, `onRemoveSession`, `onSetActive`. The `+` button adds a new generic shell tab AND opens the drawer if it's collapsed. Every tab has a close (×) button. Closing the last tab collapses the drawer.

---

## Modified Files

### `package.json`
- Added `build:server` script: `tsc --project tsconfig.server.json`
- Added new runtime deps: `node-pty`, `ws`, `@xterm/xterm`, `@xterm/addon-fit`
- Added dev dep: `@types/ws`

### `Dockerfile`
- Added `RUN apk add --no-cache python3 make g++` before `npm ci` (required for node-pty)
- Changed `CMD` to `node build/server.js`
- Added `RUN npm run build && npm run build:server`

### `.devcontainer/Dockerfile`
- Added `build-essential python3` to the `apt-get install` block (required for `npm install` to compile node-pty in the devcontainer)

### `docker-compose.yml`
- Added env vars: `WORKSPACE_ROOT=/bootstrap_workspaces`, `PRESETS_FILE=/data/presets.json`
- Added volume mounts: `${HOME:-/root}/git.workspaces:/bootstrap_workspaces:ro`, `dashboard_data:/data`
- Added named volume `dashboard_data`

### `src/routes/+page.server.ts`
- Imports `loadWorkspaces` from `$lib/server/workspaces`
- Calls `loadWorkspaces()` in the `load` function
- Returns `workspaces` alongside `containers` and `hostname`

### `src/routes/+page.svelte`
- Added imports: `LocalWorkspaces`, `BootstrapModal`, `TerminalManager`, `Play` icon, `LocalWorkspaceData` type
- Added "Run Bootstrap" button in the header
- Reads `data.workspaces` (via `untrack`) and passes to `LocalWorkspaces`
- Added `<LocalWorkspaces>` section between Devcontainers and Sandbox
- Added `<BootstrapModal>` (conditionally rendered)
- Added `<TerminalManager>` anchored at the bottom
- Terminal sessions start **empty** (no pre-created root terminal)
- Closing the last terminal tab also collapses the drawer
- Added `pb-40` to the main content div to prevent the drawer from overlapping content

### `src/routes/layout.css`
- Added `@import '@xterm/xterm/css/xterm.css';`

### `vite.config.ts`
- Added `terminalDevPlugin` — a Vite plugin that calls `attachTerminalServer` on the Vite dev server's HTTP server on startup, making the terminal WebSocket available during `npm run dev`
- Import is a **static top-level import** (compiled by esbuild with the config) — **not** a dynamic `await import(...)` inside the hook (which would fail at runtime because Node.js ESM can't find `.ts` files by their `.js` extension)

---

## Bugs Found & Fixed During the Session

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| `node-pty` build failure on `npm install` | `make` / `g++` not present in devcontainer | Added `build-essential python3` to `.devcontainer/Dockerfile` |
| Terminal drawer showed no shell in dev | WebSocket server only attached in production (`src/server.ts`); `npm run dev` uses Vite's HTTP server | Added `terminalDevPlugin` to `vite.config.ts` |
| Page reloading constantly (loop ~1s) | `vite.config.ts` used `await import('./src/lib/server/terminal.js')` at runtime — Node.js ESM can't resolve `.ts` files, threw `ERR_MODULE_NOT_FOUND`, Vite caught the rejection and restarted | Changed to a static import at the top of the config (esbuild handles `.ts` resolution at compile time) |
| Page still reloading after above fix | `attachTerminalServer` called `socket.destroy()` on **all** non-`/api/terminal` upgrade requests, which was destroying Vite's HMR WebSocket on every reconnect | Changed `socket.destroy()` to a plain `return` so Vite's own upgrade handler can proceed |
| Pre-created "Root Terminal" never got a shell | Session was created before the drawer was open and before the WebSocket server existed in dev | Removed pre-created session; sessions now start empty; terminal only opens on user action |
| `permanent` sessions couldn't be closed | `TerminalManager` had a `permanent?: boolean` field hiding the close button | Removed `permanent` concept entirely; every tab has a `×` button |
| Nested `<button>` SVG warning | Tab items used a `<button>` wrapping another `<button>` | Restructured as `<div>` containing two separate `<button>` elements |
| `+` button didn't open the drawer | `addGenericShell` added a session but didn't toggle the drawer | Added `if (!open) onToggle()` to `addGenericShell` |

---

## Architecture Notes

- **Terminal in dev vs production**: In production, `src/server.ts` creates the HTTP server and calls `attachTerminalServer`. In dev, the `terminalDevPlugin` in `vite.config.ts` hooks into Vite's HTTP server via `configureServer`. Both code paths call the same `attachTerminalServer` function.
- **Workspace data loading**: Workspaces are loaded server-side (SSR) in `+page.server.ts` via the shared `loadWorkspaces()` utility. No client-side polling. A manual Refresh button calls `GET /api/workspaces` when the user wants to rescan.
- **Svelte 5 patterns**: All new components use runes (`$props`, `$state`, `$derived`, `$effect`). xterm DOM attachment uses `{@attach}` (not the legacy `use:` action directive).

---

## Current State

The feature is fully implemented and `npm run check` passes with 0 errors and 1 pre-existing warning (`hostname` constant in `+page.svelte`).

Next steps before merging to `main`:
- Run `npm run test:unit -- --run` to verify unit tests pass
- Run `npm run test:e2e` to verify E2E tests pass
- Test the full terminal flow with an actual `devcontainer up` command
- Rebuild the Docker image to verify the production build works with `node build/server.js`
