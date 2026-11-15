# Issue #36: fresh OpenCode 2 and OpenChamber implementation

This branch starts at `main` commit `8830f1f`. It does not extend PR #37.
It installs OpenCode 2.3.0 and OpenChamber 2.7.1 on Node 24.14 or later.

## Design

- The custom server owns one foreground `opencode serve` process.
  Do not use `serve --service`: OpenCode 2.3.0 takes its password from saved
  service configuration in that mode, not the supplied environment.
- The server binds to an allocated loopback port and uses a random password.
  Readiness checks `/api/info` with that password.
- OpenChamber receives that same endpoint/password and `OPENCODE_SKIP_START=true`.
  It cannot start a replacement backend through this launch configuration.
- The `opencode` PATH wrapper always supplies `--server`. It reads the endpoint
  and password from private files, so existing terminal shells also find the
  current endpoint after startup. The runtime launches the real binary directly.
- Workspace headers, repository rows and the `/ai` folder browser have OpenCode
  and OpenChamber buttons. The click handler opens a new tab/window before
  starting any asynchronous work. The browser decides tab versus window.
- An authenticated POST creates a v2 session with `location.directory`.
  OpenChamber opens its supported `?session=` link in the existing `/service`
  viewer. The TUI attaches to that session through the existing terminal system.
- Each window has a persisted session mapping. Reloading does not create another
  conversation or PTY. After a dashboard restart, the same window resumes the
  conversation in a new PTY. Running commands do not survive replacement.
- A failed or interrupted session-creation request is not automatically retried
  as new work. Open a new window; any conversation created before an uncertain
  response remains in OpenCode's session list.
- Runtime failures stop both children and remove the endpoint file. Restart the
  dashboard to retry. There is no automatic process-replacement loop.

## Access

OpenChamber has its own login in all modes. Set `OPENCODE_PASSWORD` in the file
passed to `--env-file`, just as for the devcontainers:

```dotenv
OPENCODE_PASSWORD=your-password-here
```

The dashboard forwards that value as OpenChamber's UI password. It takes
precedence over `OPENCHAMBER_UI_PASSWORD` (retained as a compatibility fallback)
and any previously saved password. The internal OpenCode server and its clients
continue to use a separate generated API credential.

If neither environment variable is non-empty, the saved/generated UI password
is used. Retrieve the active password with:

```bash
docker exec ddash-ai-36 cat /dashboard-ai/ui-password
```

Do not paste this password into an issue or commit it.

Local mode publishes OpenChamber at `--ai-port` (default 3002, loopback in build
mode). Only OpenChamber's password-protected UI is published, not OpenCode.
Dashboard logout does not log out a separate OpenChamber session in local mode.

Tailscale mode publishes no additional Docker port. The existing authenticated
Serve gateway maps one server-generated identity to the owned OpenChamber
loopback listener. Its normal cookie, Origin and WebSocket policies still apply.
OpenChamber's login is additional protection.

The dashboard always sets OpenChamber's `OPENCHAMBER_FRAME_ANCESTORS` to exactly
`ORIGIN`. It does not append env-file values or use
`DDAS_OPENCHAMBER_FRAME_ANCESTORS`. If `ORIGIN` is absent or empty, the setting is
empty; there is no loopback wildcard fallback. Set the dashboard's exact
`--origin` for embedded access, including localhost.
For an HTTPS reverse proxy, set `OPENCHAMBER_PUBLIC_ORIGIN=https://host:port`
through the env file and route that separate origin to container port 3002.
The viewer does not rewrite root-relative assets or strip frame protections.

## Storage

The launcher mounts `/dashboard-ai` from a dedicated named volume:

- Registry mode: `dashboard_ai`.
- Build mode: `<container-name>-ai`.
- Explicit reuse: `--ai-state-volume NAME`, after stopping the old instance.

The volume retains the user-writable OpenCode binary, XDG data/state/config/cache,
OpenCode database and sidecars, OpenChamber data/config, UI password and window
mappings. An existing v2 binary is retained, including user upgrades; a new
volume gets the pinned image binary. The entrypoint changes only the mount root's
owner. A different UID requires an explicit migration while stopped.

A real kernel `flock` stays held by the Node server. A second dashboard using the
same volume fails before starting the server. Do not delete or replace the lock
file to bypass this protection. Do not share this volume with other devcontainers.
Existing real home configuration is not overwritten or silently migrated.
There is no v1 or PR #37 state migration.

These are trusted operator tools with Docker and filesystem access. Directory
validation is not an agent sandbox. An operator can explicitly bypass the PATH
wrapper and start other processes. No per-user isolation is provided.

## Operator test

Use a disposable workspace. From this branch:

```bash
mkdir -p "$HOME/ddash-ai-fixture/plain folder"
bash scripts/run-dashboard.sh --build \
  --workspace "$HOME/ddash-ai-fixture" \
  --name ddash-ai-36 \
  --port 3101 --ai-port 3102 \
  --ai-state-volume ddash-ai-36-state
```

1. Open `http://127.0.0.1:3101` and log in.
2. Open **AI folders**. Wait for `ready`. Dashboard health alone does not indicate AI readiness.
3. Read the OpenChamber password with the command above.
4. Open both buttons for `plain folder`. Confirm the selected directory in each interface.
5. Repeat from an actual workspace header and repository row.
6. Configure a provider. Create recognizable conversations in both interfaces.
7. Confirm each interface can reopen the other's conversation.
8. Open several TUI windows and run plain `opencode` in a dashboard terminal.
9. Inspect processes with `docker exec ddash-ai-36 ps -eo pid,ppid,args`.
   Expect exactly one `opencode serve`; additional TUI clients are expected.
10. Reload a TUI window. Confirm its conversation and existing PTY remain.
11. Run `docker restart ddash-ai-36`. Log in again and reload the TUI.
    Confirm its saved conversation resumes.
12. Stop the instance with `docker stop ddash-ai-36`.
13. Rebuild with a new container name, the same workspace path and the same volume:

```bash
bash scripts/run-dashboard.sh --build \
  --workspace "$HOME/ddash-ai-fixture" \
  --name ddash-ai-36-rebuilt \
  --port 3101 --ai-port 3102 \
  --ai-state-volume ddash-ai-36-state
```

14. Confirm conversations, provider credentials, OpenChamber settings and UI password remain.
15. Try a second live instance using the same volume and different ports.
    It must fail with the volume-lock error.
16. In the disposable instance, terminate the one backend PID. New launches must
    fail without spawning a replacement. Restart the dashboard to recover.
17. Test Tailscale using your existing Tailscale flags. OpenChamber must open in
    `/service` on its allocated HTTPS origin. Test login, iframe rendering, SSE,
    WebSockets, logout and reconnect. No extra AI Docker port should be published.

## Validation performed here

- Seven focused tests pass: canonical paths/symlinks, real HTTP session encoding,
  durable session mapping, interrupted creation, real Bash/flock storage setup,
  explicit-server wrapper arguments and the actual supervisor with mocked
  child-process/PTY boundaries.
- All 100 deployment regressions pass.
- All 33 Tailscale regressions pass.
- `bash -n` passes for both new scripts, the launcher and the entrypoint.
- All three changed Svelte components compile with Svelte 5.55.2 without warnings.
- The Svelte autofixer checked the new components and the workspace-row
  integration excerpt. No correctness issues were reported.
- Changed TS/Svelte/JSON files were formatted with Prettier. Tailwind sorting
  used default rules because the full project dependency tree is unavailable.

Not performed: real Docker build, real AI process startup, real SQLite conversation
recovery, browser acceptance, Tailscale end-to-end acceptance, full project
type/lint/build checks. The sandbox has no internet access, Docker or npm.
The public OpenCode binary package was too large for the attachment limit, so it
could not be run here. The focused tests are not evidence that those checks pass.
Keep the PR in draft until the operator checks pass. No image was published.
