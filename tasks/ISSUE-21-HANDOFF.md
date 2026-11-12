# Issue #21: HTTPS service gateway implementation handoff

## Status

> **Update (2026-11-04, OpenCode continuation session):** the continuation plan below has
> been executed on this branch. Phase 0 hygiene, real type/build checks, CI registration,
> the UI wiring, the validated service matrix, and docs are done and recorded in commits
> after `32a6d26`. The remaining open items are the real Tailscale deployment validation
> (manual, needs the operator), PR #20's merge/retarget cycle, and optional follow-ups
> listed at the end of this file.

This is an **incomplete, opt-in backend foundation**, not a verified fix for the blank Supervisor/OpenCode viewer. Keep the child PR in draft and issue #21 open.

- Branch: `fix/https-service-embedding`.
- PR base: `fix/18-production-host-bind-mounts` (PR #20), not `main`.
- Child starting revision: `7b4af2e88fba3df3c9d1c7d91ed8a6ad76def5e8`.
- Parent observed during implementation: `66ab765f79b280d0b62c6c45dac32dc12e813d13`.

Fetch and merge/rebase the parent locally before continuing. Preserve the parent's newer AGENTS.md, CI changes, and OpenCode skill migration. No parent-branch changes, merge, release, or deployment were performed here.

## Implemented

- A dependency-injected Node HTTP/HTTPS gateway at `/service-proxy/<container-id>/<container-port>/<upstream-path>`.
- Authentication before Docker access, with an exact Origin check on mutations and WebSocket upgrades.
- Fresh running-container and published TCP-port validation on every request.
- An explicit web-port/protocol allowlist that excludes database ports.
- Bounded Docker lookup and upstream response-header/upgrade deadlines. No idle timeout is applied after response headers, so long-lived streams can remain active.
- Streaming bodies, SSE, raw upgrade/head-byte forwarding, and disconnect cleanup.
- Hop-by-hop header filtering, dashboard credential removal, prefix-scoped service cookies, confined redirects, and safe error messages.
- Upstream frame restrictions are preserved. Upstream CORS grants and Service-Worker-Allowed are not propagated.
- Production custom-server and Vite development integration, disabled unless `SERVICE_PROXY_ENABLED=1`. Vite preview remains unsupported.
- Standalone disposable Node regressions, without Docker or project dependencies.

The gateway core imports only Node modules. Its runtime adapter uses the existing Docker singleton and authentication module. The production-server import is intended to include the new modules in the existing TypeScript server build without a Dockerfile copy rule or a new dependency. This must be confirmed with the real build.

## Critical remaining work for OpenCode

1. Install dependencies and run the complete type/build checks first. Transpilation in this environment was not a semantic TypeScript check.
2. Confirm the deployed revision and capture browser mixed-content/network messages, Docker binding addresses, network membership, and upstream frame/redirect headers. Do not record credentials.
3. Check the exact Supervisor and OpenCode versions for non-root public base-path support. **X-Forwarded-Prefix does not automatically fix root-relative assets, API paths, redirects, or WebSocket URLs.** Configure supported upstream base paths/public URLs. If an application cannot use a prefix, implement an explicit HTTPS service-origin strategy. Do not use blanket HTML/JavaScript rewriting, global root-route interception, or removal of frame protections.
4. Pass container IDs through ServiceButton callers: cards, rows, sandbox rows, and workspace services. Replace the viewer's raw URL/query authority with a validated server-load/API contract. Share URL generation between launch, service switching, and active state. **The existing Svelte UI was not changed and still constructs HTTP iframe URLs.**
5. Show useful unsupported, unreachable, and expired-session states. Iframe load/error events are not a reliable application-health check. Provide direct HTTPS navigation when embedding is unsupported.
6. Define validated runtime protocol configuration for custom ports. Current defaults are HTTP on 80, 4096, 6904, 8000, 8080, and 9001; HTTPS on 443. The injected `ports` option can override this in callers/tests, but there is no runtime JSON policy UI or environment parser yet.
7. Verify real Docker routing without broadening exposure. By default, the gateway requires one distinct inspected IPv4 address and connects to the container port. Docker isolation can still block this. `SERVICE_PROXY_HOST` selects an operator-owned route and uses the inspected published port. It is not a URL and never comes from a request. A host-gateway address may not reach a host-loopback-only publish. Do not silently publish on all interfaces, attach networks, or switch to host networking.
8. Verify upstream auth and Origin checks. The current conservative policy strips Authorization, Origin, Referer, and the dashboard cookie. Services that require Basic/Bearer auth or their own Origin checks need an explicit per-service policy. Never blindly forward dashboard credentials.
9. Add HTTPS frontend/backend and browser regressions, real RFC WebSocket messages, reconnect, abrupt disconnect, multiple containers, cookie isolation, failures after response headers, and terminal integration checks. The current upgrade fixture verifies handshake/head-byte transport, not an application WebSocket conversation. The authentication callback is stubbed in the isolated gateway tests; real dashboard session integration is untested.
10. Register the standalone gateway test command in package.json/CI. It is not wired into the existing test scripts yet.
11. Run the Svelte MCP autofixer when implementing UI changes. No Svelte files were changed in this foundation.
12. Update README/AGENTS with the settled route/configuration contract. Deliberately remove or retain the opt-in flag only after real Supervisor/OpenCode/Tailscale validation.

## Preview configuration

Set these variables in the actual dashboard process/container:

```text
SERVICE_PROXY_ENABLED=1
ORIGIN=https://YOUR-HOST.YOUR-TAILNET.ts.net
```

Set SERVICE_PROXY_HOST only when the chosen host route is known to work. The deployment launchers do not yet pass the new preview variables. Add explicit passthrough or use a disposable manually configured container. Changing a shell variable does not change the environment of an existing container.

For HTTP development on another host/port, set ORIGIN explicitly. Fallbacks are `http://localhost:5173` in Vite and localhost:PORT in production. A matching browser-facing Origin is required for writes and upgrades.

After signing in, the manual preview endpoint uses the container ID and **container port**, not the published host port:

```text
/service-proxy/<container-id>/9001/
```

The gateway does not configure an upstream base path itself. Do not use this manual route as evidence that the existing viewer is fixed.

## Trust and limitations

Same-origin service JavaScript gains dashboard-origin operator privileges. Cookie Path is routing hygiene, not isolation from hostile services. Use only trusted operator applications here; untrusted services require separate origins. The shared dashboard password still grants full Docker/terminal capability.

Docker inspection is authoritative at lookup time, not atomic across container restarts/IP reuse. Its deadline does not cancel the underlying Dockerode request. Connection budgets, lifecycle binding, and service-specific auth policies need further work before broader exposure. The gateway permits any running inspected container with an allowed, published TCP port; it does not provide per-user roles or tenant isolation.

## Validation performed

Node 22.23.1, TypeScript transpileModule, and disposable loopback HTTP/TCP fixtures:

- 18 tests passed, 0 failed.
- All four changed/new TypeScript implementation/configuration files transpiled without syntax diagnostics.
- The Node test script passed `node --check`.

No semantic application type check, formatter, lint, full app build, Docker, browser, Supervisor, OpenCode, Tailscale, or compiled-server integration validation ran here. The sandbox has no internet access or installed project dependencies. Do not treat transpilation as type checking or HTTPS source support as an executed TLS test.

The committed test file differs from the initial tested file only by leading whitespace before top-level test calls; confirm the final committed revision and rerun in the actual environment.

```bash
npm ci
npm run check
npm run lint
npm run test:unit -- --run
npm run build
npm run build:server
node --test scripts/tests/service-gateway.test.mjs
npm run test:production
npm run test:e2e
npm run test:deployment
bash scripts/tests/container-smoke.sh
```

Record the exact tested revision. Keep issue #21 open until the HTTPS viewer and interactive service traffic work through the actual Tailscale URL.

## Continuation log (OpenCode, 2026-11-04)

Executed on this branch; commits `4fdb91e`..HEAD:

1. **Parent merge**: `fix/18-production-host-bind-mounts` (66ab765) merged into the child. Parent AGENTS/CI/OpenCode-skill changes preserved.
2. **Real checks**: `npm ci` (approved node-pty install scripts locally), `check` 0 errors, lint clean, prettier applied, both builds emit `build/lib/server/serviceGateway.js` (tsconfig.server.json follows imports; no copy rule needed).
3. **Test registration**: `npm run test:gateway` in package.json + CI step (build first), documented in AGENTS.md. All 18 standalone tests pass against the compiled build.
4. **Pre-existing failure fixed**: `production-smoke.mjs` login used `fetch` without an Accept header; SvelteKit negotiates `*/*` as action-JSON and returns HTTP 200 with the failure encoded in the body. Now sends `Accept: text/html`. This failure existed on the parent branch; CI only runs lint+unit.
5. **Validated service matrix** (live Chromium against the running devcontainers):
   - Supervisor 9001: document-relative links, no frame restrictions → path-proxy works (verified through the gateway).
   - noVNC 6904: self-contained + relative imports → path-proxy works; its WebSocket derives from location, so the launch URL carries `?path=service-proxy/<id>/6904/websockify`. Verified: `RFB 003.008` handshake through TLS → dashboard → gateway → websockify.
   - OpenCode 4096 (v2.2.5): root-absolute `/_assets/*`, no base-path flag, ignores X-Forwarded-Prefix → path-proxy does NOT work (assets 404 at the dashboard origin). CSP has no `frame-ancestors`, so a dedicated HTTPS origin embeds fine; pairing screen is the normal unpaired state.
6. **Docker routing**: all involved containers share the default `bridge` network, so the default inspected-IP route works. `SERVICE_PROXY_HOST` remains the fallback for stricter setups.
7. **UI wiring** (hybrid option chosen with Axel): client-safe `src/lib/serviceTargets.ts` (shared hrefs/paths/embed profiles), `SERVICE_PROXY_PORTS` env parser, shared scheme/binding exports, `/service` validating server load with proxy/legacy/unsupported/unavailable/proxy-disabled states, identity-based launch from all four ServiceButton callers, `serviceProxyEnabled` via SSR load. Gateway tests updated for unified mismatch semantics (404). 25 new unit tests; full suite green.
8. **Browser validation through the compiled server** (TLS harness ≈ Tailscale Serve, `ORIGIN=https://localhost:<tls-port>`): login → service button → viewer: Supervisor renders through the gateway, noVNC shows "Connected to root@<id>" (live VNC), OpenCode shows the explicit unsupported panel with Open-directly, **zero console errors / zero mixed content**.
9. **Deployment**: installer now emits `ORIGIN` only when set (empty `ORIGIN` crashes adapter-node at startup — pre-existing bug found and fixed; deployment test updated) and passes `SERVICE_PROXY_*` through root Compose and the installer. Empty passthroughs keep the gateway disabled.
10. **Docs**: README service-gateway section + env/routes tables; AGENTS.md env table, route/key-file tables, runtime note.

### Environmental note

`container-smoke.sh` cannot run from inside this devcontainer session: the Docker daemon is the host's and cannot see the container's `/home/axel` fixture dirs (bind sources "do not exist"). Run it on the Docker host directly.

### Remaining for the operator

- Real Tailscale validation: set `SERVICE_PROXY_ENABLED=1` + `ORIGIN=https://…ts.net` on the deployed container, restart it, sign in, and check Supervisor/noVNC embed plus the OpenCode unsupported state through the tailnet URL. Record the tested revision in issue #21.
- Run `container-smoke.sh` on the host.
- After #20 merges: retarget PR #22 to `main`, drop the handoff doc if desired, and decide on the optional dedicated HTTPS service-origin listener for embedding OpenCode (design notes in the session log; one static Tailscale rule + selector cookie).
