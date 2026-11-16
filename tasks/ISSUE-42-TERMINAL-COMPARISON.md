# Issue #42: terminal engines and devcontainer Open with

## Draft status

This is the first implementation checkpoint, not a completed feature.
The application still uses its existing xterm viewer. No alternative engine,
selector, devcontainer menu, or container OpenCode launch is wired up yet.

Owner-approved scope:

- Implement selectable xterm.js, Wraith, and wterm viewers.
- Compare OpenCode TUI compatibility and performance.
- Add Open with to devcontainer cards and rows.
- Include OpenCode TUI inside the selected devcontainer.

Tracking issue: <https://github.com/axelthas/devcontainer-dashboard/issues/42>.
Base reviewed: `d939e17f5bbb9c4b9bd2729e03aabe604265e705` on `main`.
This branch is independent of the automatic-restart PR.

## Initial code

- `src/lib/terminalView.ts` defines an engine-independent browser-view contract.
  It separates viewer resources from server process and socket ownership.
- Engine preference validation accepts only exact known identifiers and retains
  xterm as the default. It does not detect capabilities or implement runtime
  fallback. A requested preference is not evidence that an engine initialized.
- `scripts/tests/terminal-engines.test.mjs` tests preference handling without
  application dependencies. It does not validate the TypeScript interfaces or
  establish browser, PTY, or OpenCode compatibility.

## Integration sequence

1. Extract the current xterm implementation behind `TerminalViewFactory`.
   Keep process creation, JSON WebSocket handling, attach-only retries, output
   replay, input guards, and geometry guards in the shared controller.
2. Verify and pin upstream packages and licenses. Implement lazy Wraith and
   wterm factories. Record actual core and renderer identity. Treat Wraith's
   xterm-compatible and native Ghostty configurations as distinct results.
3. Add the default preference and per-terminal selector. Preserve the session ID
   when changing viewers. Serialize reset and replay before live output. Handle
   asynchronous initialization races and dispose partial resources on abort.
4. Add explicit unsupported/initialization-error states and recovery to xterm.
   Do not silently display another engine under the requested engine's name.
5. Add the devcontainer Open with menu in both grid and list views. Preserve
   container VS Code attachment, validated service targets, keyboard navigation,
   focus restoration, and existing start/stop/rebuild controls.
6. Implement server-resolved OpenCode TUI launch for the exact running container.
   Resolve container workspace, intended user, and executable availability from
   applicable metadata and inspection. Use literal executable/argv boundaries.
   Do not derive container paths by assuming host and container paths match.
7. Test the same pinned OpenCode version and workload on each engine. Record
   configuration, browser/GPU limitations, functional defects, and repeatable
   measurements before recommending a default change.

## Context and launch safety

The current local-workspace menu already has an OpenCode TUI entry. A devcontainer
action must not reuse the host/workspace action as if it ran inside the container.
The new TUI action targets the selected container and uses its resolved workspace
and user context. It uses the selected dashboard terminal viewer, not a web-service
iframe mislabeled as an embedded terminal.

Offer VS Code, Terminal, OpenCode TUI, and OpenChamber where supported. Reuse
existing validated service-opening behavior for service actions. Clearly explain
stopped containers, missing executables, unresolved workspace metadata, and
unavailable services. Reject stale or replaced container identities. Do not start
containers, install packages, or fall back to the host implicitly.

Browser disconnect, viewer disposal, drawer collapse, tab close, process exit,
explicit Stop, and server restart remain distinct events. An engine change must
not stop the PTY, recreate a process, resend startup commands, or replay input.
Preserve authentication, origin checks, filtered child environments, HTTPS and
Tailscale policies. Do not enable upstream agent-control features.

## Completion checklist

- [x] Record the expanded owner-approved scope.
- [x] Introduce the independent viewer contract and preference validation.
- [ ] Extract and regression-test the existing xterm viewer.
- [ ] Implement Wraith and wterm against the dashboard JSON transport.
- [ ] Add engine controls, identity reporting, and explicit failure recovery.
- [ ] Add devcontainer Open with in both views.
- [ ] Launch OpenCode TUI in the exact container workspace/user context.
- [ ] Test stopped/stale containers and missing launch prerequisites.
- [ ] Test lifecycle, cleanup, resizing, focus, and ordered output replay.
- [ ] Complete the OpenCode compatibility and performance report.
- [ ] Run type, lint, unit/component, build, production, and browser checks.

## Validation

Passed on Node.js 22.23.1 at this initial checkpoint: all five preference tests.

```sh
node --experimental-strip-types --test scripts/tests/terminal-engines.test.mjs
```

This initial checkpoint changes no runtime wiring or installed dependencies.
It does not claim three-engine or OpenCode support. Full validation requires the
installed project dependencies, both production builds, the built custom server,
Docker, browsers with the relevant GPU capabilities, and OpenCode fixtures.
Type checking, lint, builds, full unit/component suites, browser tests, Docker,
and OpenCode checks have not been run. The sandbox has no internet access or npm
for installing project dependencies. Keep xterm as the default until a separate
owner decision approves a change.
