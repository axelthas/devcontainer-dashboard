# Compose instances

- Issue: [#77](https://github.com/axelthas/devharbour/issues/77)
- Baseline: 2c567eb (`main`). Source is unchanged since the design review at
  8df870c; only documentation changed.
- Status: Planned
- References:
  [Compose instances (proposed)](../specification/feature_compose_instances/feature_specification_compose_instances.md),
  [Compose sandboxes](../specification/feature_compose_sandbox/feature_specification_compose_sandbox.md),
  [Managed Settings](../specification/feature_settings/feature_specification_settings.md),
  `feature/polaris-instances` (`e572dad`, `56917fd`) as a requirements source only.

## Outcome and scope

An operator creates, starts, uses and removes several instances of one Compose
selection from the repository row's Sandbox panel. Docker Services presents each
project through the presenter of its kind. The original sandbox behaves exactly
as on the baseline.

In scope: kind discovery, presenter contract, address planner, instance store
and allocator, override and instance files, run and removal integration, choice
actions, Sandbox panel Target and New instance, documentation.

Non-goals: everything in the specification's Out of scope section, porting code
from `feature/polaris-instances`, Polaris content in DevHarbour, Brain MCP changes.

Constraints that every step keeps:

- Literal argv. No shell.
- Workspace path validation, including symlinks.
- One run per project.
- No `docker compose down`. Removal only through preview and token. Volumes stay.
- No environment values, secrets or build arguments in responses or in files.
- Client components do not import `$lib/server/`. Svelte 5 runes and Nord styling.

## Prerequisites and stop conditions

- Environment: the DevHarbour devcontainer, Node 22, Docker Compose 2.24.4 or
  later for `!override`. The devcontainer has Compose v5.8.0.
- Before step 1, ask whether to use local source libraries or system-installed
  libraries for the build.
- Recheck the baseline. Stop and ask if `src/lib/server/compose*`,
  `src/lib/composeCommands.ts` or the Compose components changed.
- Stop for review after step 0, after step 3 (planner output on fixtures) and
  after step 9 (UI).
- Use a disposable Docker host for real-Docker checks. Do not use operator
  stacks or Tern images.

## Implementation steps

0. **Decide the open questions in #77.** Record the answers in the issue and
   update the specification. Checkpoint: no open decision blocks steps 1 to 4.
   Requires review.
1. **Kind descriptor.** Add client-safe types in `src/lib/stackKinds/types.ts`
   (`KindDescriptor`, `StackView`, `StackActionRequest`, `InstanceSummary`). Add
   `src/lib/server/kindDescriptor.ts`: parse and validate the top-level
   `x-devharbour` block, refuse unknown keys, limit sizes, validate container
   paths as absolute and repository paths as relative. The implementer selects
   a hand-written validator or a JSON Schema library; a new dependency requires
   review. Checkpoint: tests for valid, unknown-key, oversize and path-escape
   descriptors.
2. **Kind resolution.** Extend `inspectComposeSelection` in
   `src/lib/server/composeSandbox.ts` to return `kind` and its source. Add the
   fallback order: descriptor, operator profile, label, heuristics, `generic`.
   Keep the current response redaction. Checkpoint: `/api/compose` returns the
   kind for each fixture; no new field leaks environment values.
3. **Address planner.** Add pure `src/lib/server/composeInstancePlan.ts`:
   resolved config, pool and slot in; address plan, override document and
   warnings out; plus a collision check against other resolved stacks. Cover
   subnets, gateways, ranges, auxiliary addresses, fixed addresses,
   `extra_hosts` with `=` and `:`, container names with aliases, ports, fixed
   volume names, external networks, IPv6 refusal and environment-name
   warnings. Checkpoint: table-driven tests; review the plan for one fixture.
4. **Instance store and allocator.** Add `src/lib/server/composeInstances.ts`:
   resolve and validate the instance root, take an in-process mutex plus an
   exclusive lock file, list Docker network subnets, select a slot, write
   `instance.json` by atomic rename, read and list records, handle the
   `planned`, `ready`, `failed` and `removing` states. Make workspace discovery
   in `src/lib/server/workspaces.ts` skip `.devharbour`. Checkpoint: parallel
   create with a fake Docker client gets two slots; a stale lock file recovers.
5. **Override and instance files.** Render `override.yaml` with `!override`
   and the instance labels. Render instance files with the address map at digit
   and dot boundaries. Check the Compose version. Run `config` with the override
   and run the collision check. Checkpoint: `docker compose config` on the
   fixture with the generated override gives the expected plan, without a
   Docker daemon call.
6. **Commands and runs.** Extend `src/lib/composeCommands.ts` with an optional
   project name and a final override file. In `src/lib/server/composeRuns.ts`,
   lock instance runs by project name, keep current locks for the original
   sandbox, and pass `DEVHARBOUR_INSTANCE` and `DEVHARBOUR_SLOT`. Filter the
   child environment so that DevHarbour credentials are not inherited. Extend
   the ownership check with the instance label. Checkpoint: argv tests and
   conflict tests; the original sandbox argv is byte-identical to the baseline.
7. **API.** Add `/api/compose/instances`: list, preview a plan with a token,
   create, review plan. Let `/api/compose/run` accept an instance target. Extend
   `src/lib/server/composeRemoval.ts` and `/api/compose/remove` with the
   instance directory, record state and slot release. Checkpoint: route tests
   for stale tokens, wrong-owner refusal, drift refusal and partial removal.
8. **Choice actions.** Add `/api/compose/action`: validate the option, build
   argv from the descriptor, run `compose exec -T` per target service as one
   tracked run, run read-back, store the result per project. Checkpoint: tests
   for an unknown option, a confirmation option, a partial result and a
   failure that does not store a value.
9. **UI.** In `ComposeSandboxPanel.svelte`, add Target, New instance (slot,
   services, plan, Create), Review plan and Discard. Split
   `ComposeGroupRow.svelte` into a shared shell and a presenter registry in
   `src/lib/components/stack/` with `generic` (the current group), `web`,
   `database` and `profile` (choice action, endpoints and addresses panels).
   Run the Svelte autofixer on each component. Checkpoint: the generic
   presenter renders the current group unchanged; review against the mockup.
10. **Documentation.** Move the specification from Proposed to current
    behavior, update Compose sandboxes and the specification index, add routes
    to `ARCHITECTURE.md` and operator steps to `README.md`. Checkpoint: links
    and example paths resolve.

## Acceptance checks

- [ ] `npm run check` reports no errors.
- [ ] `npm run lint` passes.
- [ ] `npm run test:compose` passes, including the new descriptor, planner,
      allocator, command, run, removal and action tests.
- [ ] `npm run build` and `npm run build:server` succeed.
- [ ] Original sandbox regression: argv, locks, removal preview and Docker
      Services output match the baseline for the existing Compose fixtures.
- [ ] Disposable Docker host, generic fixture: create two instances in
      parallel; slots differ and subnets do not overlap.
- [ ] Start the original sandbox and both instances; no address, container
      name or published port collides; the old container name resolves.
- [ ] No environment value appears in an API response or in `override.yaml`.
- [ ] A choice action with one failing service reports `partial`.
- [ ] A changed source Compose file blocks Start until Review plan.
- [ ] Remove keeps volumes and frees the slot; a forced partial removal keeps
      the record and the slot.
- [ ] Compose below 2.24.4 gives the refusal message.
- [ ] Negative: a descriptor with an unknown key, a path outside the
      repository or a relative container path is refused.

## Delivery and recovery

- Deliver in the draft PR for #77, or split steps 1, 2 and 9 (kinds and
  presenters) into a separate issue if review prefers two PRs.
- No migration. Existing sandboxes are not renamed or converted. Removing the
  feature leaves instance directories under `.devharbour/instances`; delete
  them after removing their stacks.
- Record the tested revision, the commands, the results and the unrun checks in
  the PR. Remove this plan when #77 closes.
