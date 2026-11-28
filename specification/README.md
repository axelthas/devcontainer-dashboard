# DevHarbour specifications

Use this directory for durable product behavior. A specification tells a reader
what DevHarbour does, what it must preserve, and how to verify it. It is not a
work log or a list of implementation steps.

## Find a specification

- [DevHarbour product specification](initial_specification.md)
- [Local workspaces, terminals, and bootstrap](feature_bootstrap/feature_specification_bootstrap.md)
- [Brain shell access over MCP](feature_brain_access/feature_specification_brain_access.md)
- [Compose sandboxes](feature_compose_sandbox/feature_specification_compose_sandbox.md)
- [Compose instances](feature_compose_instances/feature_specification_compose_instances.md)
- [Git ref menu](feature_git_refs/feature_specification_git_refs.md)
- [Managed Settings and recreation](feature_settings/feature_specification_settings.md)
- [Terminal engine switcher](feature_terminal_engines/feature_specification_terminal_engines.md)

Use the [project README](../README.md) for operator instructions, the
[architecture reference](../ARCHITECTURE.md) for system structure, and the
[agent guide](../AGENTS.md) for repository and check conventions. Use GitHub
issues for work tracking and [implementation plans](../tasks/README.md) for
optional, temporary handoffs.

## Naming and layout

- `README.md` is the index and authoring guide. `initial_specification.md` is
  the existing product overview path; do not start another product overview.
- Use `feature_<slug>/feature_specification_<slug>.md` for each feature. The
  same slug must appear in both names. Match `[a-z][a-z0-9]*(?:_[a-z0-9]+)*`.
  Use a stable capability name, not an issue number, date, version, or status.
- Keep supporting assets in that feature's `mockups/` directory. For new assets,
  use descriptive `lowercase-kebab-case` names with lowercase extensions, for
  example `mockups/recreate-review.svg`. Keep existing link targets working.
- Update an existing feature specification instead of adding a second version.
  Add a new specification to the index in the same PR. Use relative links for
  repository paths, and descriptive alt text for images.

## Write or update a specification

1. Check the issue, source, and relevant tests at the same revision. Source and
   tests are evidence of current behavior; a mockup or passing unit test does
   not prove a production workflow works.
2. State observable behavior. Name the actor, trigger, result, and failure
   behavior. Use `must` for requirements and distinguish defaults from options.
   Preserve existing requirement identifiers if another document or test uses them.
3. Record interface and compatibility requirements once. Link to the owning
   specification, schema, or entry point instead of copying it.
4. Label proposed behavior as **Proposed** and link its issue. Keep deferred work
   out of the current behavior section. Remove incorrect descriptions instead of
   keeping an obsolete alternative next to the current contract.
5. Update the specification in the same PR as a behavior change. Verify titles,
   links, and example paths. Keep revision-specific results in the PR, not in
   the specification. Add no secrets, private paths, or real operator data.

## Feature specification template

Copy this outline. Use `Not applicable` when a section does not apply. Add
short subsections when the feature has more than one workflow.

```markdown
# <Feature name>

## Purpose and scope

<Who uses it, what it enables, and where it applies.>

## Behavior

<Preconditions, normal workflow, defaults, errors, and recovery.>

## Interfaces and constraints

<Relevant UI, CLI, API, or configuration. Link to source. Cover persistence,
authorization, compatibility, and lifecycle when they apply.>

## Out of scope

<What this feature does not promise. Link any proposed follow-up separately.>

## Verification

<Observable checks for success and failure. Link tests or name a safe manual
scenario. Do not report a pass here.>
```
