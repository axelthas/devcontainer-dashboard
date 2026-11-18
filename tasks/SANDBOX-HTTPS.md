# Sandbox services over HTTPS

This extends the existing Tailscale dedicated-origin gateway. It does not change
Docker publishing, attach the dashboard to sandbox networks, or create certificates
inside sandbox containers.

## Enable wildcard compatibility

Use the existing native, rootful Linux Docker host and Tailscale launcher setup.
Add this flag to the dashboard launch command:

```sh
--tailscale-allow-wildcard-bindings
```

It requires `--tailscale-socket`. It is off by default. The launcher explicitly sets
`TAILSCALE_ALLOW_WILDCARD_BINDINGS=0` or `1` after any `--env-file`, so an environment
file cannot silently opt in. Custom deployments can set that variable directly.

Keep your existing workspace, origin, dashboard port, AI state volume and Tailscale
flags. Stop the old instance before reusing its listeners or data volumes. Use
`--build` to test this branch; the published image does not include unmerged changes.

For an unlisted web service, also set its **container port** and upstream protocol:

```sh
--gateway-ports 8081:http,8443:https
```

These are example ports, not automatic discovery. Never enable a database or other
non-HTTP protocol as a web service. Upstream HTTPS certificate validation remains on.

## Web services and TCP-only ports

Docker does not report which protocol a published port speaks, and the dashboard does not
probe ports. A container port is a web service only when the service port policy names it
`http` or `https`. The policy is the built-in default list plus `--gateway-ports`:

- Defaults: `80:http`, `443:https`, and `4096`, `6904`, `8000`, `8080`, `9001` as `http`.
  Tailscale mode also adds `3000:http`.
- `--gateway-ports 5904:http` adds a port. `--gateway-ports 8080:off` removes one.
- UDP ports are never web services.

In each Docker Services row, the Services menu opens web services in the dashboard. It
copies the host address of every other port, for example for VNC, MySQL or a raw TCP
interface. The expanded details show the same split per port.

Open the service from Docker Services. Its iframe and Open directly action use an
allocated HTTPS origin. Browser traffic is HTTPS; the gateway connects locally to
`127.0.0.1:<published-host-port>` with the configured upstream HTTP/HTTPS protocol.

## Binding policy

- Default: IPv4 loopback, optionally paired with IPv6 loopback on the same host port.
- Opt-in: IPv4 wildcard `0.0.0.0`, optionally paired with `::` on the same host port.
- Refused: IPv6-only, specific non-loopback addresses, different published host ports
  for one service, malformed ports, unpublished TCP services, and stopped containers.
- Allocation probes local TCP reachability before writing a Serve entry. It does not
  test HTTP readiness, protocol correctness, application login or iframe compatibility.
- Requests, WebSocket upgrades and cleanup use the same binding policy and re-inspect
  Docker. Existing session, origin, credential filtering and ownership checks remain.
- No Funnel is enabled. Existing Tailscale access rules must allow the HTTPS port range.

**HTTPS proxying does not close the original service port.** An all-interface binding
remains accessible according to the host firewall. It can bypass dashboard authentication
through its original endpoint. Change Compose publishing separately if you want to
remove that access. Published bindings are shown in the expanded row details, not treated
as authorization data. A Compose group header counts its containers on all interfaces.

Applications can still refuse embedding with CSP or X-Frame-Options. Configure their
allowed dashboard origin where supported, or use Open directly over HTTPS. The gateway
does not strip framing protections. Root-absolute assets and WebSockets use the service
origin root, not a path prefix. Absolute URLs hard-coded to HTTP or another host may
need application configuration.

## Verification

Dependency-free regression commands:

```sh
bash -n scripts/run-dashboard.sh
node --experimental-strip-types --test scripts/tests/tailscale-*.test.mjs
node --test scripts/tests/deployment.test.mjs scripts/tests/run-dashboard.test.mjs \
  scripts/tests/bootstrap-hook.test.mjs scripts/tests/socket-symlink.test.mjs
```

Before merging, run project check, lint, browser tests and both builds. On the actual
host, use one disposable sandbox service and verify:

1. Without the flag, wildcard publishing gives the explicit policy error.
2. With the flag, its HTTPS iframe loads assets, login, redirects and WebSocket/SSE.
3. A loopback-published devcontainer still works.
4. Signed-out HTTPS service access is refused.
5. Stop or replace the service and verify stale allocations are removed.
6. Row details distinguish loopback and all interfaces, and fold IPv4/IPv6 pairs.
   The Services menu opens web ports and copies the address of TCP-only ports.
7. Existing direct HTTP access remains unchanged.
8. An application that refuses framing still works through HTTPS Open directly.
