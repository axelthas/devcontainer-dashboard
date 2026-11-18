# Feature specification: Compose sandboxes

Status: draft, implemented on `feat/compose-sandboxes`. Not validated against a real Docker daemon.

## Purpose

Many Git repositories in a workspace include Docker Compose files. Polaris solution
repositories, for example, include `docker-compose.yml` files that run a test sandbox of
the solution. The dashboard lets the operator build and run these files from the repository
row, and then connect a devcontainer to the sandbox network.

## Terms

| Term              | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| Compose sandbox   | The Compose project that one selection of Compose files defines            |
| Selection         | Ordered Compose files, an optional environment file, and optional profiles |
| Project directory | The directory of the first selected file; Compose resolves paths from it   |
| Project name      | The name that `docker compose config` resolves for the selection           |
| Stack             | The containers that carry the `com.docker.compose.project` label           |

## Discovery

1. The dashboard scans each Git repository of each task workspace.
2. It lists Compose files at the repository root and in each first-level directory.
3. It skips hidden directories, such as `.devcontainer/`, and `node_modules/`.
4. A Compose file name matches `compose.yaml`, `compose.yml`, `docker-compose.yaml`,
   `docker-compose.yml`, or a dotted variant such as `docker-compose.override.yml` or
   `compose.sandbox.yaml`.
5. A repository with at least one Compose file shows a **Sandbox** button. A devcontainer is
   not required.

## Selection

- The default selection is the Compose default file of the directory plus its matching
  `override` file, as `docker compose` loads them without `-f`.
- All selected files must be in one directory. Files merge in the order shown.
- The environment file is optional and relative to the repository. When it is empty,
  Compose reads `.env` in the project directory.
- Profiles are optional names, separated by commas or spaces.
- The browser saves the selection per repository.

## Check

The panel runs a check when it opens and after each selection change. The check runs
`docker compose config --format json` on the server. The response contains only:

- The project name and project directory.
- Per service: name, image, build flag, profiles, ports, networks, and container name.
- Per network: name, external flag, and first IPAM subnet.
- Compose warnings, for example unset variables.
- The existing containers of the project name, with state and working directory.

The response never contains environment values, build arguments, secrets, labels, or
commands.

## Actions

| Button          | Docker call                    | Effect                                   |
| --------------- | ------------------------------ | ---------------------------------------- |
| Build           | `docker compose build`         | Builds service images                    |
| Start           | `docker compose up --detach`   | Creates or reconciles and starts the stack |
| Build and start | `docker compose up --detach --build` | Builds, then starts                |
| Stop            | `docker compose stop`          | Stops containers; keeps containers and volumes |

Each call also has `--project-directory`, one `--file` per selected file, the optional
`--env-file`, and one `--profile` per profile. The panel shows the exact calls under
**Docker calls**.

`down`, volume removal, and free command entry are not available.

**Service logs** opens `docker compose logs --follow --tail 200` in the terminal drawer.

## Rules

1. The server validates every selection again. Paths must be inside the workspace root,
   also after symlink resolution.
2. The server runs Compose with literal arguments. No shell parses them.
3. The child environment excludes `DASHBOARD_PASSWORD` and editor launch variables.
4. The server checks the configuration again when an action starts.
5. If containers of the same project name belong to another working directory, or have no
   working-directory label, the server refuses the action. Compose would otherwise
   reconcile, recreate, or stop that other stack.
6. Only one action runs at a time for one project directory or one project name.
7. A browser reload, disconnect, or panel close does not stop an action.
8. **Cancel** stops the Compose process tree. It does not remove containers, networks, or
   images that Compose already created.
9. A failed action keeps its output as a log for seven days, also across a dashboard restart.
   A running action is not restored after a dashboard restart.
10. Deleting a workspace releases its run tracking. It does not remove containers.

## Connect a devcontainer

After **Start**, the stack appears under **Docker Services**. Use the existing network
drawer of a devcontainer to join a sandbox network or stand in for a stopped node.

## Known limits

- Compose runs inside the dashboard container. The launcher mounts the workspace at the same
  path, so bind mounts inside the workspace resolve on the host. Bind mounts outside the
  workspace, for example `~/` paths, resolve against the dashboard environment, not the
  operator shell.
- Registry credentials come from the dashboard runtime. Private images can fail to pull.
- The project name is the Compose default. The dashboard does not rename projects.
- The `docker compose` plugin must be available in the runtime image.

## Acceptance test

Use a disposable Docker host and a disposable workspace. Do not use an operator workspace.

1. Clone a Polaris solution repository into a task directory of the workspace.
2. Open **Local Workspaces**, expand the task, and select **Sandbox** on the repository.
3. Verify the default selection, project name, services, ports, and networks.
4. Select **Build and start**. Reload the browser while it runs. Verify that the output
   continues and that no second process starts.
5. Verify that **Docker Services** shows the stack, and that the service states update.
6. Connect a devcontainer to the sandbox network and stand in for a stopped node.
7. Select **Stop**. Verify that containers and volumes remain.
8. Clone the same repository into a second task. Select **Start** there. Verify that the
   dashboard refuses and names the first working directory.
9. Set a missing variable or an invalid file. Verify the error message, and that no process
   starts.
