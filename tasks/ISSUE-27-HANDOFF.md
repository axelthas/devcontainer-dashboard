# Issue #27: Tailscale Serve port origins

## First implementation slice

Base: `main` at `b7868846a2ab26e66d8f507a3752db15effba5a1`.

Added an inert LocalAPI client and conservative free-port selection. No runtime import,
launcher flag, socket mount, Serve write, container exposure, or UI change is enabled.
This is not the complete issue implementation.

- LocalAPI uses `GET` and `POST /localapi/v0/serve-config`.
- Updates require the exact GET ETag in `If-Match`.
- HTTP 412 re-reads and re-runs a pure merge, up to three attempts.
- Other errors fail closed. Requests have a five-second deadline and 1 MiB response limit.
- An absent socket path returns a disabled client. There is no platform/TCP fallback.
- Port selection reserves TCP, Web and Funnel keys, including foreground and service scopes.
- The caller supplies the range. No production default has been selected.

Upstream evidence, inspected at Tailscale commit
`e3ecbb9894cdcb3805e4ffc1c63c08aecb454316`:

- https://github.com/tailscale/tailscale/blob/e3ecbb9894cdcb3805e4ffc1c63c08aecb454316/client/local/serve.go
- https://github.com/tailscale/tailscale/blob/e3ecbb9894cdcb3805e4ffc1c63c08aecb454316/ipn/serve.go

These LocalAPI methods are not a stable API. Verify compatibility with the installed daemon.
The inspected Serve schema has no arbitrary ownership-tag field. Do not invent one or infer
ownership from a port range. Preserve unknown fields during merges.

## Next slice

1. Design durable ownership records before adding handlers. Persist an allocation intent
   before the conditional write so crashes do not orphan an unidentifiable handler.
   Cleanup must compare the complete expected entry and leave operator-modified entries alone.
2. Implement startup reconciliation and container/service disappearance cleanup.
   Reconcile only entries recorded as owned by this dashboard instance.
3. Route each origin through an authenticated dashboard gateway listener, not directly
   to a service's host port. The existing path gateway is not sufficient for root-absolute assets.
4. Strip the dashboard session cookie before forwarding HTTP and WebSocket requests.
   Ports do not isolate cookies. Also prevent upstream responses from overwriting the dashboard cookie.
5. Validate origin, redirects, service cookie behavior, framing, and authentication on each port.
6. Confirm HTTPS port acceptance on supported Tailscale releases. Select an explicit default range.
7. Add the opt-in launcher flag, socket permission checks, and controlled listener publication.
   Mounting tailscaled's socket grants broad host Tailscale control. A narrow host helper
   could restrict methods and target ports; this slice does not provide that helper.
8. Wire the validated viewer contract and record real Tailscale/browser tests for OpenChamber
   and OpenCode. Keep service ports on host loopback. Never enable Funnel.

## Verification

Run the focused tests without npm dependencies:

```sh
node --experimental-strip-types --test scripts/tests/tailscale-serve.test.mjs
```

The tests use a disposable Unix HTTP socket, not a real tailscaled instance.
All 10 focused tests passed on Node v22.23.1 for this first slice on 2026-11-12.
The execution sandbox has no internet access or installed project dependencies.
Full project type, lint, build, production, Tailscale and browser checks remain required.
