# Compose instances

Tracked in [issue #77](https://github.com/axelthas/devharbour/issues/77). The
original sandbox behavior is in
[Compose sandboxes](../feature_compose_sandbox/feature_specification_compose_sandbox.md).

## Purpose and scope

An operator runs more than one copy of one Compose system on one Docker host.
Each copy is an instance: a separate Compose project with its own subnets,
container names and published ports. The operator controls every instance from
the same Sandbox panel as the original sandbox.

DevHarbour also classifies each Compose system into a kind. The kind selects how
Docker Services presents the stack and can declare instance files and actions.
DevHarbour contains no values that belong to one solution, such as subnets, file
paths, modes or port numbers. A repository declares them.

## Behavior

### Terms

- **System**: one Compose selection of one repository: ordered files, optional
  environment file and profiles.
- **Original sandbox**: the system under its default project name. Its behavior
  is the behavior of Compose sandboxes.
- **Instance**: the system under a generated project name with a generated
  override file.
- **Slot**: an integer that identifies an instance in a pool.
- **Pool**: a slot range and a subnet template per network. The default
  template is `10.231.{slot}.0/24` and the default range is 1 to 254.
- **Address plan**: the map from source values to instance values for subnets,
  addresses, container names, published ports and fixed volume names.
- **Kind**: the classification of a system, for example `generic`, `web`,
  `database`, or a kind that a repository declares.
- **Presenter**: a built-in set of components that renders a stack of a kind.

### Select a target

- The Sandbox panel of a repository row keeps its files, version, check,
  services and actions.
- The panel shows a **Target** control. **Original sandbox** is the default and
  is always present. Each instance of the selection is also present, with its
  slot and state.
- Every panel action acts on the selected target.
- An instance that has no containers appears only in the Target control.
  Docker Services shows a project only when it has containers.

### Create an instance

1. The operator selects **New instance** in the Sandbox panel.
2. The server checks the selection with `docker compose config --format json`
   and checks the Compose version.
3. Under one exclusive lock, the server selects the first free slot in the pool
   and the kind's slot range, and reserves it.
4. The server writes the instance directory and checks the merged
   configuration. It does not create containers or networks.
5. The panel shows the planner warnings and selects the new instance as the
   target.

A slot is free when no Docker network subnet, no instance record, no
original-sandbox subnet and no reserved range overlaps its subnets. The server
fails closed when the pool is exhausted or when it cannot read Docker networks.
Only removal of the instance record releases a slot.

### Address plan

The server derives the plan from the resolved configuration. The browser only
displays the result.

- A managed bridge network with one explicit IPv4 subnet gets the subnet of
  its template for the slot. Source and destination prefix lengths must match.
  The gateway, IP range and auxiliary addresses move by the same offset. Each
  managed network must have a distinct destination subnet.
- A network without an explicit subnet needs no address change.
- A network with a fixed `name` gets the name `<instance>_<key>`.
- An external network stays shared, unless the kind marks it `perInstance`. The
  server refuses an instance when a shared external network has fixed service
  addresses.
- A fixed service address keeps its host part in the new subnet.
- `extra_hosts` values use the same address map, in both the `=` and `:` forms.
- A fixed `container_name` becomes `<instance>-<service>`. The old name stays
  resolvable as a network alias on each instance network.
- An instance publication binds to `127.0.0.1` and Docker allocates the host
  port. The original sandbox ports do not change.
- Every non-external named volume uses a random instance identity, separate
  from the slot and project name: `devharbour_<identity>_<key>`. Reusing a slot
  does not attach a retained volume. External volumes stay shared.
- The server does not rewrite environment values. The plan lists only the names
  of variables whose value contains a source address.
- The server refuses an instance that needs an IPv6 subnet change.
- Compose interpolation receives `DEVHARBOUR_INSTANCE` and `DEVHARBOUR_SLOT` for
  instance calls, so that a repository can parameterize itself.

### Run an instance

- Instance calls add `--project-name <instance>` and give the override file as
  the last `--file`. The original sandbox calls do not change.
- Instances share the images of the host. **Start** does not pull.
- Before an action, the server checks the source, the kind and the instance
  policy again. When one of them changed since the plan, the server refuses the
  action and the panel offers **Review plan**. Review plan keeps the slot and
  the volume identity.
- The server refuses an action when a container of the instance project does
  not carry the instance label and the volume identity of that record.

### Run a kind action

- A kind can declare a choice action, for example a mode, with options, target
  services, an argument template and an optional read-back command.
- The browser sends only the selection, the target, the action identifier and
  the option.
- The server validates the option, substitutes it as one argument and runs the
  command in each target service with `docker compose exec -T` as one tracked
  run. It then runs the read-back command.
- The server stores the value, the time and the result (`ok`, `partial` or
  `failed`) per project in process memory. A restart clears it. A failed run
  does not store a new value.
- An option that the kind marks for confirmation requires a confirmation.

### Remove an instance

- Removal uses the reviewed preview and token of Compose sandboxes. The preview
  also lists the instance directory.
- Removal removes the containers, the networks of the instance and the instance
  directory. It keeps volumes, images and source files. No action runs
  `docker compose down`.
- **Remove instance** in the Sandbox panel also discards a prepared instance
  that has no containers, with the same preview.
- A partial removal keeps the record and the slot.
- Removal reads only the instance record. When the source workspace is deleted,
  Docker Services can still stop the instance containers and remove the
  instance.

### Classify a system

The first source that answers decides the kind:

1. A top-level `x-devharbour` block in the resolved configuration.
2. An operator profile in DevHarbour data, matched by canonical repository path
   and ordered files, for a repository that the operator cannot change.
3. An allowlisted built-in kind label (`generic`, `web` or `database`) when all
   running containers of the owned project agree. This is display-only.
4. Built-in heuristics: `web` for published HTTP ports, `database` for official
   database images without HTTP ports. Heuristic kinds are display-only.
5. `generic`.

The server validates each kind descriptor and refuses unknown keys, interpolated
values, oversize values and paths that escape the repository. An invalid
declaration does not fall through to a later source. Inspection shows a warning
and uses `generic`, and the server refuses new instances. The original sandbox
is not blocked. Label and heuristic kinds do not enable instance files or
actions. Compose drops service-level extension fields from `config` output, so
per-service values must be in the top-level block.

A descriptor has `schema: 1` and can declare:

- `kind`, `title` and `presenter`.
- `services`: a role (`app` or `support`) and endpoints (port, label,
  protocol) per service.
- `defaults.services`: the services that the panel selects by default.
- `instances`: the slot range, network templates and `perInstance` flags, the
  port policy (`loopback-ephemeral`) and instance files.
- `actions`: choice actions.
- `panels`: `endpoints`, `addresses`, `urls` or `choice:<action>`.

Example, with placeholder values:

```yaml
x-devharbour:
  schema: 1
  kind: example-stack
  presenter: profile
  services:
    web: { role: app, endpoints: [{ port: 8080, label: UI, protocol: http }] }
  defaults: { services: [web] }
  panels: [addresses, 'choice:mode']
  instances:
    networks:
      backend: { subnet: '10.231.{slot}.0/24' }
    files:
      - id: hosts
        from: { path: config/hosts }
        rewrite: addresses
        mount: { role: app, target: /etc/example/hosts }
  actions:
    mode:
      type: choice
      label: Mode
      options: [primary, standby]
      confirm: [standby]
      services: [web]
      argv: [example-mode, '{option}']
      readBack: [example-mode, --show]
```

An instance file comes from a repository path. The server renders it with the
address map at digit and dot boundaries into the instance directory and mounts
it read-only at an absolute container path. DevHarbour does not run repository
scripts to render files.

### Present a stack

- Docker Services renders each Compose project through the presenter of its
  kind. A shared shell renders the header (name, version, kind and slot chips,
  running count) and the group actions. A presenter adds header actions, panels
  in the expanded group and an addition to each container row.
- Built-in presenters are `generic`, `web`, `database` and `profile`. `web` and
  `database` add endpoint chips. `profile` composes built-in parts from the
  descriptor: choice actions, endpoints and an addresses panel. A repository
  configures a presenter. It never supplies code.
- An unknown presenter falls back to `generic`. `generic` adds nothing, so the
  group matches the original Compose group.
- An instance project opens the instance removal preview from its group.

## Interfaces and constraints

- The instance root is `<WORKSPACE_ROOT>/.devharbour/instances/`. Each instance
  directory contains `instance.json`, `override.yaml` and `files/`. The root is
  inside the workspace mount, so bind mounts of rendered files resolve on the
  host. Workspace discovery skips `<WORKSPACE_ROOT>/.devharbour/`.
- Operator profiles are JSON descriptors in
  `/data/compose-kind-profiles/<key>.json`. The key is the SHA-256 of the JSON
  array of the canonical repository path and the ordered files. DevHarbour has
  no editor for profiles.
- The pool comes from the DevHarbour server environment.
  `DEVHARBOUR_INSTANCE_POOL` replaces the default subnet template.
  `DEVHARBOUR_INSTANCE_RESERVED` lists CIDR ranges, separated by commas or
  spaces, that no slot can use.
- The server validates every source, file and instance path below the workspace
  root, including symlinks.
- The override file contains no environment values. The server writes instance
  files by atomic rename.
- Instance containers carry the `devcontainer-dashboard.instance`,
  `devcontainer-dashboard.slot` and `devcontainer-dashboard.volume-identity`
  labels. A declared kind adds `devcontainer-dashboard.kind` and
  `devcontainer-dashboard.presenter`.
- The override uses the Compose `!override` tag. The server refuses instances
  below Compose 2.24.4 with a clear message. The original sandbox has no new
  version requirement.
- Run conflicts are per project. Instance runs lock the instance project, not
  the shared source directory. Original sandbox runs keep their current locks.
- Responses contain no environment values, build arguments, secrets or labels
  outside the DevHarbour labels. Compose child processes do not inherit
  DevHarbour credentials.
- API: [instances](../../src/routes/api/compose/instances/) (list, create,
  review plan), [instance removal](../../src/routes/api/compose/instances/remove/)
  (preview, remove), [kind action](../../src/routes/api/compose/action/),
  [stack view](../../src/routes/api/compose/stack/) and the instance target of
  the [run API](../../src/routes/api/compose/run/).
- Source: [descriptor validation](../../src/lib/server/kindDescriptor.ts),
  [kind resolution](../../src/lib/server/composeKinds.ts),
  [planner](../../src/lib/server/composeInstancePlan.ts),
  [store and allocator](../../src/lib/server/composeInstances.ts),
  [orchestration](../../src/lib/server/composeInstanceService.ts),
  [removal](../../src/lib/server/composeInstanceRemoval.ts),
  [command contract](../../src/lib/composeCommands.ts) and
  [presenters](../../src/lib/components/stack/).

## Out of scope

- Selection of a slot by the operator and an address plan preview before
  **Create**.
- IPv6 subnet changes, non-bridge managed networks and more than one explicit
  IPAM subnet per managed network.
- Host route and VPN range detection. Use `DEVHARBOUR_INSTANCE_RESERVED`.
- Pool configuration in Settings.
- Persistence of kind action results across restarts.
- Volume removal.
- Presenter code from repositories.
- File extraction from images.
- Exposure of instances through the Brain MCP endpoint.

## Verification

Use a disposable Docker host and a fixture without solution content: two
networks with fixed subnets, fixed addresses, `extra_hosts`, a fixed
`container_name`, a published port, a fixed volume name and an instance file.
The Compose tests in
[compose-sandbox.test.mjs](../../scripts/tests/compose-sandbox.test.mjs) cover
the descriptor, planner, allocator, commands, runs, removal and actions with a
fake Docker client. They do not establish real-Docker acceptance.

- Open the panel. Check that the original sandbox behaves as in Compose
  sandboxes.
- Create two instances in parallel. Check different slots and no overlap.
- Check the override. Check that no environment value appears in a response or
  in the override.
- Start the original sandbox and both instances. Check that no address, name or
  port collides and that the old container name resolves.
- Run a choice action with one failing service. Check the `partial` result.
- Change the source Compose file. Check that Start is refused until Review plan.
- Remove an instance. Check that volumes stay and the slot is free. Force a
  failed container removal and check that the record and the slot stay.
- Use a Compose version below 2.24.4. Check the refusal message.
