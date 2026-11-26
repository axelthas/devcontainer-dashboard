# DevHarbour Settings and minimal startup

Status: initial implementation in draft PR #71. Host-CLI apply is implemented; live/per-build readers and an external apply helper remain deferred.

Work record: [issue #70](https://github.com/axelthas/devcontainer-dashboard/issues/70).
Parent: [CLI PR #66](https://github.com/axelthas/devcontainer-dashboard/pull/66).
Design: [interactive Settings mockup](https://app.clickup.com/9012329445/artifact/8cjuez5-123452?version=1).
Baseline: `feat/65-devharbour-cli` at `9ba441e569a91df00a3ab39d8935c3aa6b492a8f`.

## Purpose

Start DevHarbour locally with a password, then configure it in the browser.
Keep the Python CLI, coloured puffin banner, explicit flags and advanced wizard.
The UI and CLI edit the same host config.json. Neither owns a separate settings store.
The prototype illustrates interaction intent. It is not proof of runtime behavior.

## Startup and lifecycle

On a supported local Linux Docker host, `devharbour` and `devharbour start`
start or resume the managed instance. New installations use 127.0.0.1:3000.
The normal first run asks only for a hidden login password. Optional integrations
remain off. Existing saved settings remain authoritative on subsequent starts.

The CLI validates the non-root local identity and detects trusted host-agent
providers using the existing discovery rules. It uses the operator's known_hosts
when that file exists. An inaccessible or ambiguous agent, remote-host context,
port conflict or missing prerequisite must produce actionable guidance or an
explicit advanced-setup path. Simplicity must not weaken the SSH contract.
Do not pick a forwarded session socket, provision an agent, alter permissions,
mount private keys, or guess another host's identity.

Commands:

- `start`: ensure the current managed instance is ready; review changed deployment inputs.
- `stop`: stop the owned instance without changing configuration.
- `restart`: restart the existing container, not silently apply deployment changes.
- `status`: report runtime health and saved-versus-applied state.
- `logs`: show retained runtime logs without printing credentials.
- `open`: open the effective URL when a browser is available; otherwise print it.
- `apply`: review and reconcile saved desired settings, including recreation if needed.
- `setup`: open the full guided wizard for advanced and headless use.

Preserve compatible `run`, `configure`, isolated `build`, explicit flags and
unattended behavior. Distinguish managed startup from isolated checkout builds.
Preserve existing ownership, adoption, image preparation and readiness checks.

## One configuration contract

Use one shared JSON Schema and Python/TypeScript conformance fixtures. Preserve
schema-1 compatibility, launcher flag names, instance identity, path semantics,
unknown-key rejection and default behavior unless a migration is explicit.
Inventory every supported launcher and managed-source option before implementation.
The mockup's simplified field list is not the complete schema.

Mount the containing config directory so atomic replacement is visible from the
host and container. A single-file bind pins an inode and is not sufficient.
Resolve host versus container paths explicitly. Validate permissions and mapped
operator ownership; do not broaden permissions to make the mount writable.
Keep directories private (0700) and config, locks, state and secrets private (0600).

Both writers must use the same cross-process lock and atomic synced write contract.
A UI save includes the revision it read. Reject stale revisions without replacing
newer CLI edits. Lock contention must fail or wait in a bounded, documented way.
Save desired state separately from last-applied state. A successful save is not a
successful deployment. Reuse canonical host identity for ownership labels: a
container-visible config path must not create a different installation owner.

Serve authenticated, validated settings APIs with origin/CSRF checks and a strict
editable-field allowlist. Enforce safe path resolution and symlink handling.
Reject arbitrary file access and shell interpretation. Direct/unmanaged deployments
without a config mount show an unavailable or read-only state with instructions.
They must not create an unrelated configuration automatically.

Keep secrets in referenced private files, not config.json, browser storage, logs,
error output or review diffs. Secret read APIs return status, not plaintext.
Provide write-only replacement inputs. Environment-file editing must preserve
unrelated lines/comments and respect ordered env-file precedence. Define recovery
for partial failure when more than one file changes; do not imply a multi-file
atomic transaction merely because each individual write is atomic.

## Settings page

Use Svelte 5 runes, existing Nord colors, the puffin identity and current desktop
and mobile navigation conventions. Add an authenticated Settings entry point.
Support keyboard navigation, accessible labels, validation errors and unsaved-change
navigation warnings.

Sections:

1. General: host label, restart policy, image/source selection and advanced readiness settings.
2. Access: localhost, Tailscale HTTPS or custom binding; DevHarbour web port,
   origin, password replacement and advanced gateway/Tailscale controls.
3. Host and SSH: operator identity, workspace, Docker/SSH sockets and known_hosts.
4. Devcontainers: managed environment values, custom variables and ordered env-file references.
5. AI and MCP: OpenChamber port/state, MCP listener, token references and Funnel.
6. Bootstrap: startup hook and relevant provider/preset configuration references.
7. Config file: active host path, permissions, schema version, desired/applied state,
   redacted file preview and host command guidance.

Every field shows its default, effective value and apply policy. Distinguish the
DevHarbour web port (3000), OpenChamber web port (3002), MCP listener (3100) and
OpenCode inside devcontainers (4096). Hide irrelevant fixed OpenChamber host-port
controls under Tailscale, where the gateway uses a dynamic loopback port.

Provide Discard, Save only and reviewed Apply controls. Highlight changed fields
and changed file-preview lines. A pending banner identifies saved deployment
changes that the running instance has not applied. The redacted file preview
must reflect actual persisted keys, not UI-only state.

Tailscale discovery must run against the actual Docker host through a supported
read-only path. Preserve the validated whoami/status fallback and manual path.
A browser/container cannot assume that a host-only CLI is installed locally.
Missing prerequisites never imply working certificates or Serve routes.

MCP copy explains that agents get container grants one by one. Enabling the
listener grants nothing. Funnel exposes the bearer-protected MCP listener only,
not the DevHarbour UI. Public access requires Tailscale prerequisites and explicit
exposure approval, equivalent to the CLI's existing exposure guard.

## Apply policies

The following are target capabilities, not existing runtime guarantees:

- **Live**: a setting applies without container recreation, after a validated
  runtime update path exists. Candidates are the displayed host label, VS Code
  SSH host and Docker restart policy. Keep runtime state, persisted desired state,
  last-applied bookkeeping and ownership fingerprints consistent.
- **Next build**: a new devcontainer build reads a validated environment file and
  merges permitted values through the existing child-environment filters. Existing
  devcontainers retain old values until an explicit rebuild. Do not rebuild them
  automatically. Current Docker env-file injection alone requires recreation.
- **Recreate**: ports, bindings, origins, mounts, image/source changes and startup
  integrations normally require replacing DevHarbour's container. Preserve all
  established ownership and replacement checks.

OPENCODE_PASSWORD also configures DevHarbour's own OpenChamber runtime. Its impact
cannot be labelled only Next build. Evaluate every consumer and show combined
impact where necessary. The initial version may conservatively classify unsupported
live changes as Recreate; never advertise a reader that has not been implemented.

Initial apply path: the UI saves and directs the operator to `devharbour apply`
on the host. It must not stop its own container before another component owns
the operation. Validate inputs and prepare source/image before stopping the old
container. Keep retained volume names and exact-container approval/adoption rules.
Never delete volumes or silently adopt a legacy installation.

The review must explain interruption and recovery:

- DevHarbour recreation discards its writable layer and ends its process-local
  login sessions, MCP grants and local PTY processes.
- Separate devcontainers normally remain running. Orchestration and commands owned
  by DevHarbour can be interrupted; do not promise all active work survives.
- Named volumes stay. There is no automatic transactional rollback guarantee.
- Port/origin changes require a new URL. Password changes require the new password.
- Current process-local authentication means the user must log in after recreation.
  Do not promise transparent authenticated reconnection.
- A failed deployment leaves desired state saved but not applied. Report durable
  operation status and actionable retry/recovery instructions.

The external apply helper delivers the mockup's one-click flow as specified in
the implementation record below. It has an exact target, lock handoff, narrow
operation contract, durable status, readiness checks and failure recovery. It
survives replacement of the requesting process; the web server never removes
itself directly.

## Compatibility and non-goals

Preserve config/flag names, persistent volumes, image repository, browser storage
keys, MCP identifier and saved instance names. This feature does not provision host
packages, add generic remote-daemon support, provide per-user RBAC, change SSH trust,
expose anything publicly by default or rebuild devcontainers automatically.

Current dev-bootstrap templates forward OPENCODE_PASSWORD and TERN_USE_CCACHE.
OPENCODE_SKIP_START and OPENCODE_PORT require forwarding in devcontainer.json.
Show that limitation; this repository's settings work does not fix another
repository's templates.

## Delivery and validation

1. Implement minimal startup and lifecycle semantics.
2. Add the shared contract, config mount and read-only Settings page.
3. Add safe editing, dirty state and proven live/per-build readers.
4. Add reviewed host-CLI apply and failure reporting.
5. Add a separately validated helper if one-click recreation is required.

Acceptance follows issue #70. Cover password-only startup and prerequisite failures,
CLI compatibility, Python/TypeScript schema agreement, file ownership/symlinks,
concurrent and stale writes, secret redaction, authentication/origin checks,
mobile/keyboard interaction and desired-versus-applied reporting. Use disposable
Docker resources for replacement/adoption failures, retained-volume behavior,
changed origin/port/password, terminated sessions and helper recovery. Validate the
custom production server and WebSocket path, not only Vite preview.

At the initial scaffold commit (`4601576`), this document-only change executed no runtime behavior. No build, unit,
CLI, browser or Docker acceptance checks were run for it. Mockup interactions are
simulations, not acceptance results for the production application.

## Initial implementation record

The first implementation includes password-only local quickstart, lifecycle verbs,
a shared schema, the managed directory mount, authenticated browser editing,
redacted previews, write-only credential/environment replacement, stale-edit and
cross-process lock handling, and host-CLI apply. The Settings page is available
from both interfaces. All apply policies are conservatively Recreate. Tailscale
origin discovery remains in the host wizard, with manual origin entry in the UI.

At the initial implementation commit, live application, per-build environment
loading and the independent recreate helper were not implemented. Real Docker mount/replacement, native-host discovery and Tailscale
acceptance remain outstanding; browser tests use a disposable custom server and
mocked CLI tests do not prove Docker behavior. See the PR for exact validation
commands, revision and results. The original mockup remains a design reference,
not a claim that every simulated interaction is shipped.

## Full-width layout and independent apply implementation

The header now has edge-aligned branding and controls, viewport-centered status
pills, and a circular Settings cog. Pills move to another row before collisions.
The Settings category rail remains fixed-width; settings and JSON share the rest
of the viewport with a draggable/keyboard separator. Narrow layouts use inline
JSON preview. The draft dock offers Discard, Save only and Save & recreate.

The shared saved-change banner persists across desktop/mobile/Settings and page
reloads. An authenticated review endpoint validates an unsaved candidate without
saving it and issues a 10-minute token bound to desired/input revision and current
owned container. Queue requires explicit replacement confirmation and separate
increased-exposure approval. Expired, changed and duplicate operations are refused.

The queue saves the reviewed desired state and launches an independent helper
from the running image ID. It runs as the numeric operator, retains necessary
supplementary groups for Docker, drops capabilities and has read-only root storage.
Only config-directory and Docker-socket binds are writable; reviewed external
inputs/workspace/source are read-only. No host-home mount or arbitrary command
API is introduced. A short delay lets the queue response reach the browser.

The worker uses the authoritative CLI, not a second deployment implementation.
It guards desired/input revision after acquiring the exclusive lock, prepares the
image before stopping anything, rechecks exact container identity, recreates and
checks app/Docker/SSH-agent readiness. Last-applied state advances only after
readiness. Durable phases are queued, validate, image, recreate, health, succeeded
and failed. Worker death is reconciled only after checking Docker; a Docker outage
is not treated as proof of worker death. Old helper containers auto-remove after
exit, but operation/review state remains private for recovery.

Browser disconnect does not cancel apply. The banner distinguishes interruption
from success and directs the user to the configured new address and a fresh login.
There is no automatic rollback or automatic devcontainer rebuild. Live/per-build
application remains deferred. Real Docker/Tailscale replacement is a separate
acceptance step; mocked Docker regressions and fixture progress are not that proof.
