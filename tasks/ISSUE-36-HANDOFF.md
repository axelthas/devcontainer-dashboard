# Local AI draft: issue #36

## What this draft implements

- OpenCode **2.3.0** from the official v2 installer, not `opencode-ai`.
- OpenChamber **2.7.1**, using the same dashboard-owned OpenCode service.
- Node 24 in both image stages, with an explicit Node 24.14 minimum check.
- A **Local AI** link on the dashboard and a one-level folder picker at `/ai`.
  Any readable directory under the mounted workspace root is eligible. Git and
  devcontainer metadata are not required. Canonical paths reject escaping symlinks.
- **Open in OpenCode** starts its TUI in the existing dashboard terminal.
- **New OpenChamber session** creates an empty v2 session with
  `location.directory` set to the selected folder, then opens its supported
  `?session=...` link. It does not submit a prompt or start an agent task.
  Existing conversations remain in the applications' session lists.
- An authenticated, dedicated OpenChamber origin. Root-relative assets, streaming
  responses and WebSockets do not depend on a fragile path-prefix rewrite.
  A direct-open link remains available if upstream frame restrictions prevent embedding.

## Test the draft

Do not replace your current installation. Use a disposable workspace first.
From this branch's checkout, with unused host ports:

```bash
mkdir -p "$HOME/ddash-ai-fixture/plain folder"
bash scripts/run-dashboard.sh --build \
  --workspace "$HOME/ddash-ai-fixture" \
  --name ddash-ai-test \
  --port 3101 --ai-port 3102 \
  --ai-state-volume ddash-ai-36-test
```

Open `http://127.0.0.1:3101`, log in, and select **Local AI**. Wait for its
service status to become `ready`. The dashboard health check does not imply
that the separate AI services are ready.

1. Select `plain folder`. OpenCode must start with that working directory.
2. Create an OpenChamber session. Confirm its folder is `plain folder`.
3. Configure a provider in OpenCode. Do not put provider secrets into Git.
4. Create a recognizable conversation. Confirm both applications see the same
   backend sessions.
5. Reload the browser and reopen the conversation.
6. Run `docker restart ddash-ai-test`. Log in again and reopen the conversation.
7. Stop the test instance with `docker stop ddash-ai-test`.
8. Rebuild with a new container name, the same workspace path and the same AI volume:

```bash
bash scripts/run-dashboard.sh --build \
  --workspace "$HOME/ddash-ai-fixture" \
  --name ddash-ai-rebuilt \
  --port 3101 --ai-port 3102 \
  --ai-state-volume ddash-ai-36-test
```

9. Confirm the conversation, provider configuration and OpenChamber settings remain.
10. While the rebuilt instance runs, start a second test instance on other ports
    with the same volume. It must refuse the live volume lock. Do not remove the
    lock file to bypass this check.

Also test Unicode, quotes and spaces in folder names, an escaping symlink,
logged-out requests, WebSocket reconnect, service failure, and an expired
dashboard session while streaming.

## Persistence and lifecycle

The launcher mounts a dedicated volume at `/dashboard-ai`.

- Registry mode defaults to `dashboard_ai`.
- Build mode defaults to `<test-container-name>-ai`.
- `--ai-state-volume NAME` explicitly reuses a volume after the previous
  instance has stopped. Never share it with a devcontainer.
- The volume contains the user-writable OpenCode binary, XDG data/state/config/cache,
  the v2 SQLite database, OpenChamber home/config state and a private service password.
- The state script holds a kernel `flock` for the dashboard lifetime. Exit releases
  the lock without deleting persistent files.
- Fresh volumes receive the image's pinned v2 binary. Existing v2 binaries are
  retained, including user upgrades. Image rebuilds do not overwrite them.
- Root setup changes only the mount root's owner and mode. It does not recursively
  follow persisted files. A different operator UID requires explicit offline migration.
- Existing real home directories are not automatically copied or deleted.
  This draft does not migrate sessions from an older dashboard container or v1.
- Browser disconnect does not stop the backend. Restart/rebuild interrupts running
  commands. Saved conversations persist; running processes and dashboard login
  sessions do not.
- Services start as the dashboard operator with dashboard-password/editor-hook
  environment variables removed. Failures are shown as `failed`; restart the
  container to retry. No unbounded automatic restart loop is introduced.

Back up this volume while the dashboard is stopped. It contains credentials as
well as conversation history. Do not commit its contents or attach it to a ticket.

## Access modes

For local HTTP, the launcher publishes only the authenticated OpenChamber gateway
on loopback (`--ai-port`, default 3002). The backend services use allocated loopback
ports inside the container and are not published.

With the existing Tailscale flags, the dashboard allocates an HTTPS origin through
its existing authenticated Serve gateway. A server-created synthetic identity maps
only the owned local OpenChamber process into that gateway. Existing Docker-service
identities and policies remain unchanged. No additional AI host port is published.

For another reverse proxy, set `LOCAL_AI_ORIGIN=https://your-dashboard-host:PORT`
through `--env-file`, route that origin to the AI gateway, and retain the original
Host header. It must have the same hostname and protocol as the dashboard but a
different port, so the host-only dashboard cookie remains available. A different
subdomain is not supported by this draft.

The upstream OpenChamber frame policy is retained. An operator-supplied
`OPENCHAMBER_UI_PASSWORD` remains an additional OpenChamber login requirement.
Relay hosting is disabled for the managed process. Do not enable upstream tunnels
without reviewing their separate access policy.

This remains a trusted single-operator tool with writable workspaces and Docker
access, not a multi-user isolation boundary. Folder validation restricts dashboard
selection; it does not sandbox what an authenticated coding agent can execute.

## Validation

```bash
node --experimental-strip-types --test scripts/tests/local-ai*.test.mjs
bash -n scripts/ai-state.sh scripts/ai-entrypoint.sh scripts/run-dashboard.sh docker-entrypoint.sh
npm run check
npm run lint
npm run test:deployment
npm run test:unit -- --run
npm run build
npm run build:server
npm run test:production
npm run test:e2e
```

Executed during preparation:

- Eight focused Node tests passed: v2 session arguments/response shape, folder
  validation, credential and cookie isolation, Origin enforcement, redirect and
  service-worker rejection, denied WebSocket upgrade, persistent state across home
  recreation, exclusive live-volume locking and refusal to overwrite existing state.
- `bash -n` passed for the two new AI scripts.
- The four new server TypeScript modules transpiled with esbuild.
- Svelte autofixer reported no component issues. Its generic effect suggestions
  refer to the intentional, cleaned-up readiness polling timer.

The persistence tests use real files, symlinks, Bash and flock, with a mocked mount
probe and a fake OpenCode binary. They are **not** Docker or real SQLite tests.
The sandbox has no Docker, no internet access, and no installed dashboard dependency
tree. Full type/lint/build checks, npm installation, browser rendering, successful
WebSocket/SSE traffic, real service readiness, Tailscale integration and actual
restart/rebuild conversation recovery are not yet verified. Keep this PR in draft
until those checks pass. No image was published and no deployment was changed.

## Implementation evidence

The implementation follows the dev-bootstrap feature's separation of installation,
private live database state and application configuration, but does not copy its
private provider defaults, shared credential seeds or Tern configuration.

Upstream contracts were checked at these revisions:

- OpenCode `73abe63ac23224d88e739e7028882e547ef65a79` (2.3.0):
  `packages/cli/src/commands/commands.ts`, `handlers/api.ts`,
  `packages/protocol/src/groups/session.ts`, `packages/schema/src/location.ts`.
- OpenChamber `c075210f9a67d45701281c3cdd150e9db9f480af` (package 2.7.1):
  `packages/web/package.json`, `packages/docs/content/docs/opencode-server.mdx`,
  `packages/ui/src/hooks/useRouter.ts`, `packages/ui/src/lib/router/parseRoute.ts`.

Runtime acceptance is still required even when source contracts match.
