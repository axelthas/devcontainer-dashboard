# Compose sandboxes

## Purpose and scope

An operator can discover Compose files in a local repository, inspect the
resolved configuration, run a sandbox, and connect a Dev Container to its
network. A repository does not need its own Dev Container configuration to run
its sandbox.

## Behavior

### Discover and select a sandbox

- The dashboard looks for Compose files in the repository root and in first-level
  directories. It skips hidden directories and `node_modules`. It accepts
  standard `compose` and `docker-compose` names and dotted variants.
- Choose ordered files from one directory. The default uses the preferred base
  file and its matching override when present. The first file sets the Compose
  project directory. An environment file and profiles are optional. Without a
  selected environment file, normal Compose `.env` resolution applies.
- The panel checks the selection with `docker compose config --format json`. It
  shows the project, services, networks, warnings, and related containers. It does
  not expose environment values, build arguments, secrets, labels, or commands
  from the resolved service configuration.
- The optional tag changes registry image references for the selection. It does
  not change the checked-in Compose files.

### Start, stop, and inspect services

The service selection controls which services build, start, or appear in the
log stream. All services are selected by default. Dependencies of selected
services stay included. A service outside the selection keeps its state unless
stopped explicitly. The browser remembers deselected services for the sandbox
kind, defined by repository name and ordered file selection. Newly added services
therefore start selected.

- **Build** builds selected services.
- **Start** starts in detached mode without pulling. If a registry image is
  missing, use **Pull** or **Pull and start**.
- **Build and start** builds and starts in detached mode.
- **Pull** pulls registry images and skips buildable services.
- **Pull and start** starts only after a successful pull.
- **Stop** stops the project without deleting containers or volumes.
- **Stop unselected** stops running services outside the selection.
- **Service logs** follows selected service logs in the terminal drawer.

An active operation survives browser reload, disconnect, or panel close.
Cancelling an operation stops the process, not resources that it already created.
After startup, the stack appears under **Docker Services**. Use a Dev Container's
network controls to connect it to the sandbox.

### Remove a sandbox

Removal is separate from stopping. Review the target and current Docker
resources before confirming. A stale preview requires a fresh review. Removal
keeps volumes, images, source files, and shared networks. The sandbox does not
provide arbitrary Compose command entry or a volume removal action.

## Interfaces and constraints

- The server resolves and validates paths below the workspace root, including
  symlinks. It executes allowlisted actions with literal arguments. It validates
  service names against the resolved configuration and rechecks live state when
  an action starts.
- The server refuses an action when a project of the same name belongs to
  another working directory. It prevents conflicting operations for the same
  project or project directory.
- A Docker Compose plugin must be available to DevHarbour. Bind paths resolve
  in the runtime environment, not in the operator's shell. Private registry
  images require credentials available to that runtime.
- References: [command and selection contract](../../src/lib/composeCommands.ts),
  [inspection API](../../src/routes/api/compose/),
  [run API](../../src/routes/api/compose/run/), and
  [removal API](../../src/routes/api/compose/remove/).

## Out of scope

The dashboard does not assign a unique project name to each checkout. **Proposed:** [Compose instances](../feature_compose_instances/feature_specification_compose_instances.md) ([#77](https://github.com/axelthas/devharbour/issues/77)). It does
not restore active Compose commands after a server restart. Deleting a workspace
releases its run tracking but does not remove the stack.

## Verification

Use a disposable Docker host and a fixture with an override file, a buildable
service, a registry image, and a dependency. Check default file order, dependency
selection, missing-image Start refusal, Pull and start, persistence across browser
reload, and project-name collision from a different directory. Verify separately
that Stop preserves containers and volumes and that reviewed removal keeps volumes,
images, and source files. Mocked checks do not establish real-Docker acceptance.
