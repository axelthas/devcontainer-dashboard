# Compose instances

**Proposed** in [issue #77](https://github.com/axelthas/devharbour/issues/77).
Nothing in this specification is implemented. The current behavior is in
[Compose sandboxes](../feature_compose_sandbox/feature_specification_compose_sandbox.md).

## Purpose and scope

An operator runs more than one copy of one Compose system on one Docker host.
Each copy is an instance: a separate Compose project with its own subnets,
container names and published ports. The operator starts every instance from the
same Sandbox panel as the original sandbox.

DevHarbour also classifies each Compose system into a kind. The kind selects how
Docker Services presents the stack and can declare instance files and actions.
DevHarbour contains no values that belong to one solution, such as subnets, file
paths, modes or port numbers.

## Behavior

### Terms

- **System**: one Compose selection of one repository: ordered files, optional
  environment file and profiles.
- **Original sandbox**: the system under its default project name. Its behavior
  is the behavior of Compose sandboxes.
- **Instance**: the system under a generated project name with a generated
  override file.
- **Slot**: an integer that identifies an instance in a pool.
- **Pool**: a slot range and a subnet template per network, for example
  `192.168.{slot}.0/24`.
- **Address plan**: the map from source values to instance values for subnets,
  addresses, container names, published ports and fixed volume names.
- **Kind**: the classification of a system, for example `generic`, `web`,
  `database`, or a kind that a repository declares.
- **Presenter**: a built-in set of components that renders a stack of a kind.

### Select a target

- The Sandbox panel of a repository row must keep its files, version, check,
  services and actions.
- The panel must show a **Target** control. **Original sandbox** is the default
  and is always present. Each instance of the selection is also present.
- Every panel action must act on the selected target.
- An instance that has no containers must appear only in the Target control.
  Docker Services must show a project only when it has containers.

### Create an instance

1. The operator selects **New instance** in the Sandbox panel.
2. The server checks the selection with `docker compose config --format json`.
3. The server proposes the first free slot. The operator can select another free
   slot.
4. The server shows the address plan, the services and the warnings.
5. The operator selects **Create**.
6. The server reserves the slot, writes the instance directory and checks the
   result. It must not create containers or networks.
7. The panel selects the new instance as the target.

A slot is free when no Docker network subnet, no instance record and no
original-sandbox subnet overlaps its subnets. The server must select and reserve
the slot under one exclusive lock. Only removal of the instance record releases
a slot.

### Address plan

The server must derive the plan from the resolved configuration. The browser
must only display it.

- A network with an explicit IPv4 subnet gets the subnet of its template for the
  slot. The gateway, IP range and auxiliary addresses move by the same offset.
- A network without an explicit subnet needs no address change.
- A network with a fixed `name` gets the name `<instance>_<key>`.
- An external network stays shared, unless the kind marks it per instance. The
  server must refuse an instance when a shared external network has fixed
  service addresses.
- A fixed service address keeps its host part in the new subnet.
- `extra_hosts` values use the same address map.
- A fixed `container_name` becomes `<instance>-<service>`. The old name must stay
  resolvable as a network alias on each instance network.
- A fixed published host port becomes an ephemeral port on `127.0.0.1`, unless
  the kind sets another port policy.
- A named volume with a fixed `name` gets the name `<instance>_<key>`. Other named
  volumes are already scoped to the project.
- The server must not rewrite environment values. The plan lists only the names
  of variables whose value contains a source address.
- The server must refuse an instance that needs an IPv6 subnet change.
- Compose interpolation receives `DEVHARBOUR_INSTANCE` and `DEVHARBOUR_SLOT` for
  instance calls, so that a repository can parameterize itself.

### Run an instance

- Instance calls must add `--project-name <instance>` and must give the override
  file as the last `--file`. The original sandbox calls do not change.
- Instances share the images of the host. **Start** must not pull.
- Before an action, the server must check the source again. When the new plan
  differs from the instance record, the server must refuse **Start** and the
  panel must offer **Review plan**. Review plan keeps the slot.
- The server must refuse an action when containers of the instance project do
  not carry the instance label of that record.

### Run a kind action

- A kind can declare a choice action, for example a mode, with options, target
  services, an argument template and an optional read-back command.
- The browser must send only the project, the action identifier and the option.
- The server must validate the option, substitute it as one argument and run the
  command in each target service with `docker compose exec -T` as one tracked
  run. It must then run the read-back command.
- The server must store the value, the time and the result (`ok`, `partial` or
  `failed`) per project. A failed run must not store a new value.
- An option that the kind marks for confirmation must require a confirmation.

### Remove an instance

- Removal must use the reviewed preview and token of Compose sandboxes. The
  preview must also list the instance directory.
- Removal must remove the containers, the networks of the instance and the
  instance directory. It must keep volumes, images and source files. No action
  runs `docker compose down`.
- A prepared instance without containers can be discarded from the Sandbox panel
  with the same preview.
- A partial removal must keep the record and the slot.
- When the source workspace is deleted, its instances must still allow **Stop**
  and **Remove**.

### Classify a system

The first source that answers decides the kind:

1. A top-level `x-devharbour` block in the resolved configuration.
2. An operator profile in DevHarbour data, matched by repository name and file
   selection, for a repository that the operator cannot change.
3. The DevHarbour kind label on running containers of the project.
4. Built-in heuristics: `web` for published HTTP ports, `database` for official
   database images without HTTP ports. Heuristic kinds are for display only.
5. `generic`.

The server must validate each kind descriptor and refuse unknown keys. A
heuristic kind must not enable instance files or actions. Compose drops
service-level extension fields from `config` output, so per-service values must
be in the top-level block.

The descriptor can declare:

- `kind`, `title` and `presenter`.
- Service roles (`app` or `support`) and endpoints (port, label, protocol).
- Default services.
- Instance slots, network templates, the port policy and instance files.
- Choice actions and the panels to show.

An instance file comes from a repository path. The server renders it with the
address map into the instance directory and mounts it read-only at an absolute
container path. DevHarbour must not run repository scripts to render files.

### Present a stack

- Docker Services must render each Compose project through the presenter of its
  kind. A presenter supplies a header, a container row, actions and optional
  panels. A shared shell places them.
- Built-in presenters are `generic`, `web`, `database` and `profile`. `profile`
  composes built-in parts from the descriptor. A repository configures a
  presenter. It never supplies code.
- An unknown presenter falls back to `generic`. `generic` must match the current
  Compose group.

## Interfaces and constraints

- The instance root is `<WORKSPACE_ROOT>/.devharbour/instances/`. Each instance
  directory contains `instance.json`, `override.yaml` and `files/`. The root is
  inside the workspace mount, so bind mounts of rendered files resolve on the
  host. Workspace discovery must skip `<WORKSPACE_ROOT>/.devharbour/`.
- The server must validate every source, file and instance path below the
  workspace root, including symlinks.
- The override file must not contain environment values. The server writes
  files by atomic rename.
- Instance containers carry the instance and slot labels with the existing
  `devcontainer-dashboard.` prefix.
- The override uses the Compose `!override` tag. The server must check the
  Compose version and refuse instances below 2.24.4 with a clear message.
- Run conflicts are per project. Instance runs lock the instance project, not
  the shared source directory. Original sandbox runs keep their current locks.
- Responses must not contain environment values, build arguments, secrets or
  labels outside the DevHarbour labels.
- Compose child processes must not inherit DevHarbour credentials.
- References: [Compose sandboxes](../feature_compose_sandbox/feature_specification_compose_sandbox.md),
  [command contract](../../src/lib/composeCommands.ts),
  [inspection](../../src/lib/server/composeSandbox.ts),
  [runs](../../src/lib/server/composeRuns.ts),
  [removal](../../src/lib/server/composeRemoval.ts).

## Out of scope

- IPv6 subnet changes.
- Host route and VPN range detection. Settings can reserve ranges.
- Volume removal.
- Presenter code from repositories.
- File extraction from images.
- Exposure of instances through the Brain MCP endpoint.

## Verification

Use a disposable Docker host and a fixture without solution content: two
networks with fixed subnets, fixed addresses, `extra_hosts`, a fixed
`container_name`, a published port, a fixed volume name and an instance file.

- Open the panel. Check that the original sandbox behaves as in Compose
  sandboxes.
- Create two instances in parallel. Check different slots and no overlap.
- Check the plan and the override. Check that no environment value appears in a
  response or in the override.
- Start the original sandbox and both instances. Check that no address, name or
  port collides and that the old container name resolves.
- Run a choice action with one failing service. Check the `partial` result.
- Change the source Compose file. Check that Start is refused until Review plan.
- Remove an instance. Check that volumes stay and the slot is free. Force a
  failed container removal and check that the record and slot stay.
- Use a Compose version below 2.24.4. Check the refusal message.
