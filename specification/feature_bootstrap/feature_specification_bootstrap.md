# Local workspaces, terminals, and bootstrap

## Purpose and scope

An operator can find repositories in the configured workspace root, run a
bootstrap preset or custom command, and build a Dev Container from a repository
that has a Dev Container configuration. The dashboard displays active operations
with the workspace data.

## Behavior

1. **Local workspaces** lists project folders and their repositories. The server
   combines repository discovery with active bootstrap runs and Dev Container
   builds so that work can appear before it finishes.
2. **Run Bootstrap** starts a run from a preset or a custom command. A run name
   and command are required. A destination is optional for an interactive run.
   When supplied, it must be a simple directory name below the workspace root.
3. **Build & Start** starts a separate tracked build for the selected repository.
   Its progress is visible without holding open the original browser view.
4. A terminal session is independent of a WebSocket viewer. Collapsing the
   drawer, reloading, or disconnecting does not stop the process. Reattach to the
   existing session to resume viewing it. Explicit session close is not the same
   as disconnect. Use the action for that operation to cancel or dismiss it.

## Interfaces and constraints

- `WORKSPACE_ROOT` selects the workspace root. The default in the dashboard
  runtime is `/workspaces`. See the [CLI reference](../../scripts/README.md) for
  the host path and mount contract.
- `PRESETS_FILE` selects the preset file. The default is `/data/presets.json`.
  The presets API supports reading, saving, and deleting presets. Presets require
  a name and command; they can also carry interactive mode and field definitions.
- The [bootstrap provider module](../../src/lib/server/bootstrap.ts) owns provider
  loading and fallback. The [workspace module](../../src/lib/server/workspaces.ts)
  owns discovery. The [shared types](../../src/lib/types.ts) own data shapes.
- See the [workspace](../../src/routes/api/workspaces/),
  [bootstrap run](../../src/routes/api/bootstrap/run/),
  [presets](../../src/routes/api/presets/), and
  [Dev Container build](../../src/routes/api/devcontainer/build/) routes. The
  [custom server](../../src/server.ts) serves the production terminal WebSocket.
- Bootstrap commands are operator-controlled inputs. Use trusted presets and
  providers. Do not use a real operator workspace for validation.

## Out of scope

This feature does not define the Dev Container terminal engine switcher or remote
agent access. See [terminal engines](../feature_terminal_engines/feature_specification_terminal_engines.md)
and [Brain access](../feature_brain_access/feature_specification_brain_access.md).

## Verification

1. Discover a test repository with a Dev Container configuration in a disposable
   workspace.
2. Start a bootstrap run and a Dev Container build. Verify that each appears
   with its own progress.
3. Reload while a shell is running. Reopen its viewer and verify that the same
   process and retained output are still available.
4. Cancel a disposable run explicitly. Verify the final state separately from
   the behavior of closing a viewer.
5. Submit an invalid destination. Verify that the server refuses it before a
   run starts.
