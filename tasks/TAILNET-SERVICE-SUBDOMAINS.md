# Wildcard service subdomains over Tailscale

This branch is stacked on PR #22. It gives every devcontainer web service its own
HTTPS origin at `/`, discovered from Docker at request time:

```text
https://<container-port>-<12-hex-container-id>.<node>.<tailnet>.ts.net:8443/
https://4096-3f2a9c1b7d8e.host.tailnet.ts.net:8443/   (example)
```

There is no per-service configuration. A new or recreated container gets a new
hostname automatically. The dashboard embeds the service in its existing viewer.

## How it works

1. Tailscale's `dns-subdomain-resolve` node attribute makes every
   `*.host.tailnet.ts.net` name resolve to the Docker host.
2. One wildcard certificate (`*.host.tailnet.ts.net`) covers all service names.
3. Tailscale Serve forwards one raw TCP port (8443) to one dashboard TLS listener
   on host loopback (4443). The dashboard terminates TLS.
4. The listener reads the Host header, for example `4096-3f2a9c1b7d8e`.
5. Opening a service in `/service` validates the running container, then issues a
   30-second, single-use ticket bound to that origin, the full container ID and
   the dashboard session. The ticket travels in a URL fragment.
6. A bridge page on the service origin exchanges the ticket for a host-only
   `__Host-ddash-service-session` cookie, then loads the application root.
7. Every request and WebSocket upgrade is authenticated before Docker access. The
   session grant, never the request, selects the full container ID. A recreated
   container therefore never inherits an older session.

Requests reach the application unchanged at `/`, including assets, APIs, SSE,
uploads and WebSockets. Path-prefix incompatibility does not apply. Encoded path
segments pass through unchanged, because a subdomain needs no prefix confinement.
The viewer delegates clipboard and fullscreen access to subdomain frames only.

## Security model

- Devcontainer ports stay published on host loopback only.
- Only ports allowed by the existing `SERVICE_PROXY_PORTS` policy are routed.
  Defaults: 80, 443, 4096, 6904, 8000, 8080, 9001. Add others with `--gateway-ports`.
- `ts.net` is on the Public Suffix List, so the site is `<tailnet>.ts.net`. Service
  subdomains are same-site with the dashboard: iframe cookies are not third-party.
- Each subdomain is its own host, so host-only cookies are isolated per service.
  The gateway removes `Domain` from application cookies and drops reserved names.
- Same-site pages can send `SameSite=Strict` cookies. The dashboard therefore
  rejects cross-origin writes, reads, subresource loads and frames.
- Dashboard logout invalidates service sessions. Live streams and WebSockets close
  within about one second. Sessions also expire after eight hours or a restart.
- The gateway strips dashboard and gateway credentials, `Authorization`, upstream
  CORS grants, `Alt-Svc`, `Clear-Site-Data` and service-worker registrations.
- This is not a hostile-application sandbox. Proxied apps are trusted operator tools.
- The wildcard private key is readable inside the dashboard container. Dashboard
  operators already have full terminal and Docker access.

## One-time setup

Run these steps on the Docker host as the dashboard operator. Replace
`host.tailnet.ts.net` with your node name.

1. In the tailnet policy file, add the node attribute. Use a tag or the node's
   tailnet IP as the target:

   ```json
   "nodeAttrs": [
     { "target": ["100.x.y.z"], "attr": ["dns-subdomain-resolve"] }
   ]
   ```

2. Update Tailscale on the Docker host and on every browsing device. Subdomain
   resolution is done by the client's MagicDNS resolver. Current release: v1.104.5.
3. From a browsing device, check resolution:

   ```sh
   nslookup 4096-test.host.tailnet.ts.net
   ```

   The answer must be the host's tailnet IP.

4. Create a private directory for the certificate:

   ```sh
   install -d -m 700 ~/.config/devcontainer-dashboard/tls
   ```

5. Request the wildcard certificate. Quote the name:

   ```sh
   sudo tailscale cert \
     --cert-file ~/.config/devcontainer-dashboard/tls/cert.pem \
     --key-file ~/.config/devcontainer-dashboard/tls/key.pem \
     '*.host.tailnet.ts.net'
   ```

   Without the node attribute, Tailscale returns
   `wildcard certificates are not enabled for this node`.

6. Give the files to the operator and restrict the key:

   ```sh
   sudo chown "$USER": ~/.config/devcontainer-dashboard/tls/*.pem
   chmod 600 ~/.config/devcontainer-dashboard/tls/key.pem
   ```

7. Renew on a timer. Run the commands from steps 5 and 6 weekly, for example from
   cron or a systemd timer. `tailscale cert` reissues only when renewal is due.
   The dashboard reloads changed files within ten minutes without a restart.
8. Check existing Serve listeners, then add one raw TCP route:

   ```sh
   tailscale serve status
   tailscale serve --bg --tcp=8443 tcp://127.0.0.1:4443
   ```

   Do not use Funnel. Your existing dashboard route on 443 does not change.
9. Allow approved users to reach TCP 8443 on the host in the tailnet policy.
10. For OpenChamber, allow the dashboard as frame ancestor in that devcontainer:

    ```sh
    OPENCHAMBER_FRAME_ANCESTORS=https://host.tailnet.ts.net
    ```

## Run the dashboard

Use your existing command and add the service flags:

```sh
bash scripts/run-dashboard.sh --build --gateway --ssh-dir --bootstrap \
  --password-file ~/.config/devcontainer-dashboard/password \
  --origin https://host.tailnet.ts.net \
  --service-domain host.tailnet.ts.net \
  --service-cert "$HOME/.config/devcontainer-dashboard/tls/cert.pem" \
  --service-key "$HOME/.config/devcontainer-dashboard/tls/key.pem" \
  --gateway-ports 3000:http
```

- `--service-domain` must equal the hostname of `--origin`.
- `--service-port` (default 8443) is the browser-facing port from step 8.
- `--service-listen-port` (default 4443) is the host loopback port.
- `--gateway-ports 3000:http` enables OpenChamber's port. Change it to match your
  installation. `--gateway` keeps the PR #22 path gateway for other services.
- The dashboard reaches services directly on their container network address.
  This works when the dashboard and devcontainers share a Docker network, for
  example the default bridge. For other layouts, use host networking with
  `--gateway-host 127.0.0.1`.

## Test checklist

1. Open the dashboard from a second tailnet device and log in.
2. Open OpenCode and OpenChamber from the dashboard. Both must render in the viewer.
3. Test chat streaming, terminal input and resize, uploads, reload and navigation.
4. Open two services at the same time.
5. Log out. New requests must fail, and open live connections must close.
6. Recreate a devcontainer. Open its service again from the dashboard.
7. Confirm that the published devcontainer ports are unreachable remotely.

## Environment contract

| Variable                           | Default               | Purpose                                     |
| ---------------------------------- | --------------------- | ------------------------------------------- |
| `SERVICE_SUBDOMAIN_BASE`           | unset (disabled)      | Node name; must equal the `ORIGIN` hostname |
| `SERVICE_SUBDOMAIN_PUBLIC_PORT`    | `8443`                | Browser-facing HTTPS port in generated URLs |
| `SERVICE_SUBDOMAIN_LISTEN_PORT`    | `4443`                | Listener port inside the dashboard          |
| `SERVICE_SUBDOMAIN_LISTEN_ADDRESS` | `0.0.0.0`             | Listener address inside the dashboard       |
| `SERVICE_TLS_CERT_FILE`            | required when enabled | PEM certificate for `*.<node>`              |
| `SERVICE_TLS_KEY_FILE`             | required when enabled | PEM private key                             |

An invalid configuration or unreadable certificate stops startup. The listener is
production-server-only; Vite does not start it.

## Validation record

In the authoring environment, the following ran against isolated
TypeScript-transpiled modules:

- `service-subdomains.test.mjs`: 10 tests passed.
- `service-gateway.test.mjs` from PR #22, unchanged: 18 tests passed.
- `run-dashboard.test.mjs`, including 3 service-flag cases: 63 tests passed.
- A real TLS check with a self-signed wildcard certificate: SNI, ticket
  exchange, asset request and WebSocket upgrade passed.

Not run: Prettier, the project ESLint setup, `svelte-check`, Vitest, SvelteKit and
server builds, Docker, real browsers, the Tailscale node attribute, `tailscale cert`
with a wildcard, or real OpenCode and OpenChamber embedding. Run `npm run format`
and `npm run lint` before you open a pull request.
