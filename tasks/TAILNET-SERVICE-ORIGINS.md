# Dedicated service origins: opt-in test deployment

This branch is stacked on PR #22. It adds root-mounted, authenticated service
listeners for applications that cannot use `/service-proxy/.../`. It does not
configure Tailscale, publish an image, or change existing installations.

## Initial supported topology

- Docker Engine on Linux.
- One HTTPS tailnet hostname with a distinct external HTTPS port per service.
- Tailscale Serve terminates HTTPS and forwards each listener to a private HTTP
  listener on the Docker host's loopback interface.
- The dashboard runs with host networking in the new test runner. It binds only
  `127.0.0.1:4300`; service listeners also bind only `127.0.0.1`.
- `SERVICE_PROXY_HOST=127.0.0.1` selects current Docker-published loopback ports.
  Docker inspection resolves the random host port on every request.
- Each route names a full 64-character Docker container ID and a container port.
  A recreated container needs an explicit config update and process restart. The
  gateway never silently reassigns a service origin to a replacement container.
- A maximum of 32 configured service routes. This is explicit routing, not yet
  an automatically allocated origin pool.

Host networking trades away the dashboard container's network isolation. The
dashboard already has privileged Docker-socket access; use only a trusted
development host. This runner is not a Docker Desktop or remote-daemon solution.

## Security and compatibility contract

Opening a configured service in `/service?cid=...&port=...` issues a 30-second,
single-use ticket tied to the dashboard session, service origin and full Docker
identity. The ticket travels in a URL fragment, not a query or Referer. A tiny
gateway-controlled bridge clears the fragment before exchanging it via an
exact-origin POST. Tickets are bearer capabilities; do not share launch URLs.

The service session uses a reserved, service-specific `Secure; HttpOnly;
SameSite=Strict` cookie. All routes require it except the inert launch page and
ticket exchange. All application routes, assets, APIs and upgrades use the same
authenticated streaming gateway. Sessions expire after eight hours. Dashboard
logout invalidates new requests immediately; live streams and upgraded sockets
close within approximately one second. Restart invalidates every ticket/session.
An idle open page can retain already rendered data after logout.

Different ports separate DOM access, storage and service workers, NOT cookies.
The gateway therefore:

- Drops dashboard/session credentials and Authorization before forwarding.
- Namespaces upstream Set-Cookie names and only restores this service's app
  cookies on upstream requests. Domain and Path are replaced.
- Blocks reserved cookie names, upstream CORS grants, Alt-Svc, Clear-Site-Data,
  and service-worker registration requests.
- Enforces exact-origin writes and upgrades; the dashboard rejects sibling-origin
  browser fetches/forms and refuses framing.

This is not a hostile-app sandbox. Same-host ports still share a cookie jar.
App JavaScript that expects original `document.cookie` names, cookies scoped to
distinct paths with identical names, `__Host-` app cookies, cross-origin login
flows, and PWA/service-worker behavior are not supported by this initial profile.
Such apps need compatibility work or separate service hostnames.

The proxy preserves upstream X-Frame-Options and CSP. Configure applications to
permit the exact dashboard ancestor if they refuse framing. Do not blanket-strip
frame protections. An app with `SAMEORIGIN` will reject a different-port iframe.
OpenCode and OpenChamber still require real-browser validation at installed
versions. HTTP/SSE/upgrade fixture success is not proof of app compatibility.

## Build and test on the Docker host

1. Check out `feat/tailnet-service-origins`.
2. Copy `service-origins.example.json` to an operator-owned config outside the repo.
3. Replace the hostname with the existing dashboard tailnet hostname.
4. Replace each placeholder ID with `docker inspect --format '{{.Id}}' CONTAINER`.
5. Check each application's actual container port. OpenChamber's example uses
   3000; change it if your installation differs.
6. Choose free loopback listener ports and external HTTPS ports. Check
   `tailscale serve status` first. Do not overwrite existing services.
7. Put a strong password in an owner-readable file outside the repo.
8. Run:

   ```sh
   bash scripts/run-service-origins.sh \
     /absolute/path/routes.json \
     https://YOUR-HOST.YOUR-TAILNET.ts.net \
     /absolute/path/workspaces \
     /absolute/path/password-file
   ```

   The script builds the checked-out source, including local changes. It starts
   a uniquely named container and volumes. It does not stop previous deployments.
   It requires host port 4300 and the configured listener ports to be free.
   It enables container port 3000 in addition to the existing web-port defaults.
   For another port policy, use the equivalent Docker command with an explicit
   `SERVICE_PROXY_PORTS` value.

9. Inspect the printed container's logs and health before changing Serve.
10. After reviewing existing Serve configuration, route the dashboard HTTPS
    listener to `http://127.0.0.1:4300`. Route the service HTTPS listeners to their
    configured loopback ports. For the example:

    ```sh
    tailscale serve --bg --https=443 http://127.0.0.1:4300
    tailscale serve --bg --https=8443 http://127.0.0.1:4301
    tailscale serve --bg --https=8444 http://127.0.0.1:4302
    ```

    These commands CHANGE your host configuration. Run them yourself only after
    checking listener availability. Do not use Funnel. Restrict all three
    external ports to approved tailnet operators in the tailnet access policy.

11. Open the dashboard HTTPS URL from a second tailnet device.
12. Log in and open the configured OpenCode and OpenChamber services.
13. Test chat streaming, terminal input/resize, uploads, navigation, reload and two
    concurrent service frames.
14. Log out. Verify new requests fail and existing live connections terminate.
15. Verify the original published devcontainer ports are unreachable remotely.
16. Stop only the printed test container when finished. Remove or restore only
    the specific Serve listeners you changed; do not reset unrelated Serve state.

## Environment contract

`SERVICE_ORIGINS` contains the JSON array (not a filename). Empty/unset means no
listeners. A non-empty value requires an exact HTTPS `ORIGIN`. All service
origins must use that same hostname with distinct external ports. Invalid routes
or occupied listener ports fail startup. `DASHBOARD_LISTEN_ADDRESS` defaults to
the previous `0.0.0.0` behavior; the host-network runner always sets loopback.

The existing path gateway remains independent and opt-in. The service viewer
prefers configured root origins and otherwise retains PR #22 behavior. This
feature is production-server-only; Vite does not start root-origin listeners.
The viewer uses the existing iframe component without new client-side authority.

## Validation commands

```sh
npm ci
npm run check
npm run lint
npm run test:unit -- --run
npm run build
npm run build:server
npm run test:gateway
node --test scripts/tests/service-origins.test.mjs
npm run test:production
npm run test:e2e
```

The new Node fixture tests require compiled modules. They create disposable
loopback HTTP listeners, not Docker containers or Tailscale listeners.
`SERVICE_ORIGIN_BUILD_DIR` can point to isolated transpiled server modules.
Fixtures do not validate TLS, browser cookie enforcement, real apps, or tailnet
access policies. Record those results separately before declaring this ready.

## Implementation validation record

The authoring environment ran 13 new Node regressions and all 18 unchanged PR #22
gateway regressions against isolated TypeScript-transpiled modules: 31 passed.
The unchanged authentication source and original gateway test file were checked
against their Git blob hashes before testing. The launcher passed `bash -n`.

Full type checking, repository lint, Vitest viewer integration, the SvelteKit and
custom-server builds, Docker execution, browser cookies/frame policies and real
tailnet access were not run in that environment. It has no internet access,
project dependencies or Docker daemon. Do not treat isolated transpilation as a
successful production build or those fixture tests as live-app validation.
