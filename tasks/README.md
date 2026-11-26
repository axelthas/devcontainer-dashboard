# Implementation plans

This directory is for optional, temporary plans that a person or an agent can
execute without reconstructing the original discussion. A GitHub issue is the
work record. Write a plan only when the issue is not enough, for example when the
change spans components, requires a migration, or needs an exact validation
sequence. Do not use this directory for research notes, meeting notes, specs, or
permanent runbooks.

## Naming

Use exactly `issue-<number>-<slug>-plan.md` at the root of `tasks/`, for example
`issue-70-settings-recreation-plan.md`. Use the GitHub issue number without a
leading zero and a short lowercase slug of words separated by single hyphens.
The filename must match `^issue-[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*-plan\.md$`.
`README.md` is the only exception for new files. Use one plan per issue. If a
change has independently deliverable parts, create separate issues and link them.

## Write an executable plan

1. Link the issue and applicable specs. Pin the starting commit and list
   prerequisites, dependencies, and the environment. Recheck the baseline before
   implementing. Stop and ask if drift changes the plan's assumptions.
2. Describe the target behavior and out-of-scope changes. Name the files,
   interfaces, and invariants that matter. Do not dictate incidental code if
   multiple implementations satisfy the contract.
3. Order the steps by dependency. Give each step one deliverable and a checkpoint.
   State which decisions the implementer can make and which require review.
4. Write observable acceptance checks. Give exact commands from the repository
   root where practical, required fixtures, and expected results. Include failure
   cases and recovery when relevant. Use disposable resources for destructive
   checks. Do not use operator data, credentials, or production infrastructure.
5. Keep the plan current while work is active. Record the tested revision,
   commands, results, and unrun checks in the PR. Put durable behavior in
   [specifications](../specification/README.md), not in the plan. Remove the plan
   when the issue closes or is abandoned, after moving any durable detail and
   updating links. Git history preserves the plan.

## Plan template

```markdown
# <Change name>

- Issue: <link to the GitHub issue>
- Baseline: <full commit SHA>
- Status: Planned | In progress | Blocked
- References: <specifications, source, and dependency issues>

## Outcome and scope

<Observable outcome, in-scope changes, non-goals, and constraints.>

## Prerequisites and stop conditions

<Environment, fixtures, decision points, and approval boundaries.>

## Implementation steps

1. <One change, relevant paths or symbols, and the expected checkpoint.>
2. <Next change and checkpoint.>

## Acceptance checks

- [ ] <Command or manual check, fixture, and expected result.>
- [ ] <Negative or regression check and expected result.>

## Delivery and recovery

<Documentation to update, deployment or migration impact, cleanup and recovery
if applicable, and where to record validation evidence.>
```
