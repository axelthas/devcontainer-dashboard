# Issue #27: test automatic Tailscale HTTPS service origins

The launcher, production server, viewer, root-origin gateway, ownership journal,
and cleanup are wired. This is an operator-testable preview, not a verified release.

## Requirements and trust boundary

- Use a native, rootful Linux Docker host with Tailscale connected. Docker Desktop,
  remote Docker, rootless Docker, and Vite preview are not supported in this mode.
- Enable HTTPS certificates for the node's existing `node.tailnet.ts.net` name.
- Permit approved devices to reach both the dashboard HTTPS port and service ports
  8400-8499 in the tailnet policy. A TCP 443 grant does not cover this range.
  Never enable Funnel.
- Publish services on IPv4 host loopback, for example `127.0.0.1:14096:4096`.
  Dual IPv4/IPv6 loopback bindings must use the same host port. IPv6-only and
  public `0.0.0.0`/`::` bindings are refused. The dashboard never changes them.
- `--tailscale-socket` enables Linux host networking. Both HTTP listeners bind
  `127.0.0.1`. There is no container network isolation in this mode.
- Mounting the socket grants broad host Tailscale control. The operator UID must
  already have LocalAPI write permission; file permissions are not changed.
  If your host policy permits delegating that control, configure it explicitly:

  ```bash
  sudo tailscale set --operator="$(id -un)"
  ```

  Review the host account first. Do not use that command just to silence an
  unexplained error. The entrypoint adds the socket's group inside the container,
  but cannot grant tailscaled API authorization.

- A narrow host helper could allow only serve-config operations, owned ports,
  and loopback targets. This branch does not implement one. A read-only socket
  mount does not make LocalAPI read-only.
- Embedded services are trusted operator applications, not tenants. Ports do not
  isolate cookies. The proxy strips the dashboard session, Authorization, and
  unrelated cookies. Service response cookies get port-specific names, no Domain,
  and HttpOnly. Client-side `document.cookie` integrations are not supported.
- Dashboard HTTP policy blocks service-origin reads and mutations in this mode.
  Terminal WebSockets retain their exact dashboard-origin check.
- Old service workers can intercept requests before they reach the gateway.
  Clear site data for the test node first if you previously used these origins.

## Build and launch

Run from the checkout on the Docker host. Replace `your-node.your-tailnet.ts.net`
with the actual lowercase Tailscale DNS name.

```bash
git fetch origin
git switch feat/27-tailscale-serve-ports
git pull --ff-only
tailscale serve status
```

The example uses a separate dashboard HTTPS port, 7443, leaving an existing 443
route alone. Confirm that 7443, dashboard host port 3002, and gateway port 3003
are free. Use different ports if needed.

```bash
bash scripts/run-dashboard.sh --build \
  --name ddash-issue27 \
  --port 3002 \
  --origin 'https://your-node.your-tailnet.ts.net:7443' \
  --tailscale-socket /var/run/tailscale/tailscaled.sock \
  --tailscale-ports 8400-8499 \
  --tailscale-gateway-port 3003
```

The launcher prompts for a password. Add `--workspace PATH` for your normal
workspace tree. The container name must not already exist. Use `--build`:
registry `latest` does not contain this branch.

If OpenChamber uses container port 3000, add `--gateway-ports 3000:http`.
This extends the service allowlist without enabling the old path gateway.
OpenCode's default container port 4096 is already allowed.

Once healthy, expose the dashboard on the confirmed free HTTPS port:

```bash
tailscale serve --bg --https=7443 http://127.0.0.1:3002
tailscale serve status
```

This is the only manual Serve command needed for dashboard access. Opening a
service viewer allocates its HTTPS listener automatically. Open the dashboard at
`https://your-node.your-tailnet.ts.net:7443` and log in there, not over plain HTTP.
Two dashboards on the same hostname share a cookie name: logging into the test
can sign you out of the other dashboard even when it uses another port.

Configure OpenChamber's process before starting it:

```text
OPENCHAMBER_FRAME_ANCESTORS=https://your-node.your-tailnet.ts.net:7443
```

Use the plain dashboard origin, no path or trailing slash. The gateway preserves
CSP and X-Frame-Options; it does not weaken framing protections.

## End-to-end checklist

1. Record the commit, Tailscale version, browser version, and initial
   `tailscale serve status --json` output.
2. Open OpenCode's dashboard service button. Verify an iframe origin such as
   `https://your-node.your-tailnet.ts.net:8400/`, not a path-prefixed proxy.
3. Check root-absolute assets in the Network panel. Exercise SSE/WebSocket behavior.
4. Repeat with OpenChamber. Check frame/CSP errors if it does not embed.
5. Open the same service twice and verify that it reuses one Serve port.
6. Open another container's service and verify a different allocation.
7. In a fresh signed-out browser, verify that direct service access is refused
   until that browser signs in to the dashboard.
8. Log out during an active stream or WebSocket. Verify closure in about one
   second and rejection of subsequent requests.
9. With a disposable diagnostic service, verify that upstream requests contain
   neither the dashboard session nor Authorization. Do not log real credentials.
10. Stop a service container. Wait about five seconds and verify listener cleanup.
    Repeat for a removed container.
11. Restart the same test dashboard container and reopen a service. For crash
    recovery, kill only the disposable dashboard, then start that same container.
12. Compare Serve state with the initial snapshot. Unrelated entries, Services,
    Foreground configuration, and Funnel settings must remain unchanged.
13. Stop the dashboard and verify service-listener cleanup. The manually created
    dashboard route on 7443 is not owned by the dashboard and remains.
14. Launch without `--tailscale-socket`. Verify previous behavior, no socket mount,
    and no Serve writes.

Every request/upgrade rechecks Docker. Reconciliation runs every five seconds.
Transient Docker errors do not authorize deletion. Operator-edited entries are
left alone, including on shutdown.

## Stop and recovery

```bash
docker logs -f ddash-issue27
docker stop ddash-issue27
docker start ddash-issue27
```

Keep its data volume until cleanup finishes. Rebuilds use new containers/volumes;
stop the previous test gracefully first. Do not share one journal between instances.
After stopping the test, remove only its manually created dashboard route if needed:

```bash
tailscale serve --bg --https=7443 off
```

Never use `tailscale serve reset`. A lock from another container fails closed;
confirm that no instance uses the volume before removing its `.lock` directory.
Corrupt/lost journals are not rebuilt by guessing ownership from port numbers.
Inspect and remove only confirmed test entries manually if the journal was lost.

## Automated verification

```bash
npm ci
npm run check
npm run lint
npm run test:deployment
npm run test:tailscale
npm run test:unit -- --run
npm run build
npm run build:server
npm run test:production
npm run test:gateway
```

`test:gateway` includes `test:tailscale`, so the current PR workflow runs the new
suite. Tests use disposable Unix LocalAPI sockets, mutable Docker inspection,
real local HTTP/SSE/WebSocket servers, and mocked Docker launcher commands.
No real tailscaled is modified.

Local results on Node v22.23.1:

- 90 existing deployment regressions passed.
- 29 Tailscale client/runtime, launcher, viewer, and request-policy tests passed.
- 18 existing gateway regressions passed against an isolated esbuild-transpiled
  gateway module, not a full SvelteKit production build.
- Strict compilation of both Tailscale modules passed with target ES2020,
  Node 22 declarations, and TypeScript 5.6.3.
- Bash and POSIX shell syntax checks passed.
- Changed TypeScript, JavaScript, JSON, and Markdown files passed Prettier 3.8.1
  with repository formatting options (Svelte/Tailwind plugins omitted for these files).

The full SvelteKit build, project-wide check/lint/unit tests, Docker build, and real
Tailscale/browser tests have not run here. The execution sandbox has no internet
access or Docker daemon. Public source/type/formatter archives were downloaded
through a fresh browser; project dependencies are not installed. Record actual
end-to-end results before treating the ticket as complete.

## Contract evidence

Dashboard base: `main` at `b7868846a2ab26e66d8f507a3752db15effba5a1`.
Tailscale source inspected at `e3ecbb9894cdcb3805e4ffc1c63c08aecb454316`:

- https://github.com/tailscale/tailscale/blob/e3ecbb9894cdcb3805e4ffc1c63c08aecb454316/client/local/serve.go
- https://github.com/tailscale/tailscale/blob/e3ecbb9894cdcb3805e4ffc1c63c08aecb454316/ipn/serve.go
- https://tailscale.com/docs/reference/tailscale-cli/serve

LocalAPI is not stable. GET's ETag is sent unchanged in POST's If-Match.
HTTP 412 retries the read/merge up to three times. An ownership intent is flushed
before every attempted write. There is no invented ownership-tag field in JSON.
Default ports are 8400-8499, configurable up to 256 ports. Serve's HTTPS ports are
not Funnel's restricted public port list. AllowFunnel is never changed; even its
false-valued port keys are reserved during allocation.
