# Managed Settings and recreation

## Purpose and scope

DevHarbour lets an operator start a local managed instance with the host CLI and
edit its configuration in the browser. Both use the same host configuration.
A managed instance records desired settings separately from what it has applied.

## Behavior

### Start and edit

- The normal local startup uses loopback on port `3000` for a new installation.
  The first run asks for a login password. Optional integrations stay off unless
  configured. An inaccessible or ambiguous SSH agent, port conflict, unsupported
  Docker context, or other missing prerequisite must lead to actionable guidance.
- Existing installations reuse saved settings. `devharbour setup` opens advanced
  setup. `devharbour configure` saves configuration only. `devharbour restart`
  restarts the current instance without applying changed settings.
- **Settings** is available from the desktop header and the mobile **Host** sheet.
  Direct deployments without a managed configuration mount do not create a new
  configuration from the browser. The UI shows that managed Settings is unavailable.
- The page shows settings and a redacted preview. It distinguishes credentials
  from ordinary values and desired settings from applied state. A stale editor
  cannot replace configuration saved more recently by another writer.

### Save or apply

1. **Save only** writes desired settings. It does not change the running instance.
   A pending banner identifies saved changes that are not applied.
2. **Save & recreate** reviews new edits. **Review and recreate** reviews settings
   already saved. The host CLI also provides `devharbour apply`.
3. The browser review validates the candidate. Its approval expires and is bound
   to the reviewed input revision and exact owned container. Stale or duplicate
   requests are refused. Increased exposure needs a separate explicit approval.
4. An independent helper runs the existing CLI to apply the reviewed change. It
   prepares the image before replacing the container and rechecks the target and
   revision. Browser disconnect does not cancel the apply operation.
5. The operation records redacted progress and the outcome. The CLI advances
   last-applied state only after readiness. Failure leaves desired settings saved
   but not applied. Use the reported recovery guidance or retry from the host.

All current Settings fields use the **Recreate** apply policy. Recreation retains
named volumes but replaces the writable container layer and ends dashboard login
sessions, Brain grants, and dashboard-owned terminal processes. Separate Dev
Containers normally remain running; work orchestrated by DevHarbour can be
interrupted. Sign in again after recreation. A port or origin change can require
a new URL.

## Interfaces and constraints

- The [Settings API](../../src/routes/api/settings/) uses a fixed
  [server bridge](../../src/lib/server/settings.ts) and
  [Python Settings bridge](../../scripts/devharbour_settings.py). The
  [apply API](../../src/routes/api/settings/apply/) reviews, queues, and reports
  progress for the [independent helper](../../scripts/devharbour_apply.py).
- The managed config directory is mounted at its canonical host path so atomic
  replacement remains visible. The CLI and browser share schema validation,
  ownership checks, locking, and atomic writes. Do not silently adopt another
  installation or broaden file permissions.
- Credential read responses and previews show status or redacted references,
  not secret values. Credential replacement is write-only. Environment files
  retain their order. Do not imply that separate file writes are one atomic
  transaction.
- Preserve existing saved instance names, schema and flag compatibility, retained
  volume names, and the SSH trust boundary. Enabling MCP does not grant access.
  Public Funnel is an explicit opt-in for the dedicated MCP listener, not the
  dashboard. See [Brain access](../feature_brain_access/feature_specification_brain_access.md).

## Out of scope

There is no live apply or per-build apply policy in the current Settings UI.
Recreation does not automatically rebuild Dev Containers. There is no automatic
rollback, automatic SSH agent provisioning, or per-user role model. Track future
work on [issue #70](https://github.com/axelthas/devharbour/issues/70).

## Verification

- Check first startup and prerequisite failures; check that Save only leaves
  the same instance running and that a stale save cannot replace a newer edit.
- Check redaction, managed and unmanaged behavior, and authenticated review on
  desktop and mobile.
- On disposable Docker resources, approve recreation, disconnect the browser,
  and verify progress, readiness, retained volumes, and fresh login. Reject an
  expired review and a changed target. Check that failed readiness leaves the
  previous last-applied state unchanged. Mocked Docker and browser fixtures do
  not establish real-Docker or Tailscale acceptance.
