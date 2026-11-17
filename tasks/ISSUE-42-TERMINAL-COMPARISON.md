# Issue #42: terminal engines and devcontainer Open with

## Draft status

Second checkpoint. The engine selectors and all four viewers are wired into the UI.
They are **not yet built or run**: the lockfile and runtime validation are pending.
Devcontainer **Open with** and container-scoped OpenCode TUI are not implemented yet.

Tracking issue: <https://github.com/axelthas/devcontainer-dashboard/issues/42>.
Base reviewed: `d939e17f5bbb9c4b9bd2729e03aabe604265e705` on `main`.
This branch is independent of the automatic-restart PR.

## Required before review

The authoring environment had no npm registry access. `package.json` pins the new
packages, but `package-lock.json` is not updated, so `npm ci` fails until this is done:

```sh
npm install
npm run format
npm run check
npm run lint
npm run test:unit -- --run
node --experimental-strip-types --test scripts/tests/terminal-engines.test.mjs
npm run build && npm run build:server
```

Commit the regenerated `package-lock.json` and any formatter changes. Fix any type
errors against the installed engine typings; the adapters follow the upstream source
and documentation listed below, but they have not been type-checked.

## Implemented in this checkpoint

- `wraithterm@0.6.1` (MIT) and `@wterm/dom@0.6.0` (Apache-2.0), pinned exactly.
  `wraithterm` declares React, Svelte, and Vue as optional peers.
- `src/lib/terminalViews.ts`: lazy factories for four engines behind `TerminalView`:
  - **xterm.js**: the current xterm.js 6 viewer, unchanged in behavior.
  - **Wraith (xterm API)**: `wraithterm/xterm`; reports WebGPU or its DOM fallback.
  - **Wraith native (Ghostty)**: `Wraith.mount()`; output is written from the page.
    The dashboard JSON transport is kept; Wraith's worker socket is not used.
  - **wterm**: `@wterm/dom` with the built-in core and DOM renderer.
- `TerminalTab` keeps process creation, attach-only reconnects, input guards, and
  geometry guards. An engine change remounts only the viewer through a key block,
  reattaches by session ID, and replays retained output after a viewer reset.
- Engine failures show the reason and a **Use xterm.js** action. The identity line
  reports the engine, core, and renderer that actually initialized.
- `terminalEnginePreference.svelte.ts`: persisted default for new terminals.
- UI: **New** and **This terminal** selectors and engine badges in the drawer;
  **Terminal engine** choices in **Open with**; **Engine** selector in the OpenCode
  TUI window, kept in its URL across reloads.
- `vite.config.ts` adds `wraith()` so prebundling keeps Wraith worker and Wasm URLs.

Upstream sources used for the adapters: Wraith `packages/wraith/src/index.ts`,
`xterm.ts`, `types.ts`, and `vite.ts` at `ae0aa122`; the `@wterm/dom` README and the
wterm themes documentation.

## Known limits and checks for review

- Wraith native uses its bundled JetBrains Mono font; the dashboard font stack is not
  applied. It needs WebGPU and OffscreenCanvas in a secure context.
- Replay after a reconnect uses a full reset (RIS) for Wraith native and wterm. Verify
  that both clear the previous screen and scrollback before the replay.
- A geometry update can be sent twice after a fit. Identical PTY sizes are harmless;
  confirm that OpenCode does not redraw twice in practice.
- Hydration can briefly render the xterm.js default before the stored choice applies.
- Upstream agent-control features (wterm WebMCP) remain disabled.

## Remaining scope

- [x] Record the expanded owner-approved scope.
- [x] Introduce the viewer contract and preference validation.
- [x] Implement xterm.js, Wraith xterm, Wraith native, and wterm viewers.
- [x] Add engine controls, identity reporting, and explicit recovery to xterm.js.
- [ ] Regenerate the lockfile, then pass type, lint, unit, and build checks.
- [ ] Verify each engine against the built custom server and a real PTY.
- [ ] Add component tests: engine switch without PTY recreation or input replay,
      viewer cleanup, fallback, resize, and focus.
- [ ] Add devcontainer Open with in grid and list views.
- [ ] Launch OpenCode TUI in the exact container workspace and user context.
- [ ] Complete the OpenCode compatibility matrix and performance report.

## Validation

Not run at this checkpoint. The sandbox was unavailable, and it has no npm registry
access. The first checkpoint passed five preference tests on Node.js 22.23.1; the
updated test file covers four engines and has not been rerun.
