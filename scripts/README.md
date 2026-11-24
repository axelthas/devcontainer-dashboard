# Deployment scripts

## Structure

Executable scripts define small, named functions and call one `main` entrypoint at
the end. `main` shows the execution order. Keep parsing, validation, preparation,
execution and verification separate. Document contracts and non-obvious safety
constraints, not every shell statement.

Node test files register tests with `node:test`; they are not command runners and
do not need an artificial `main`. The production smoke runner uses `async main()`.
The launcher is self-contained so it also works through `curl | bash`: registry
mode must not source repository files or require a checkout.

## The launcher

`run-dashboard.sh` owns deployment validation and Docker launch argument construction.
The installed `devharbour` command calls it for managed deployment; direct
launcher usage remains supported as described below.

- Default (registry) mode pulls the selected image and runs it attached in the
  foreground with the stable `dashboard_data` and `ddash_zsh_data` named volumes.
  Ctrl+C stops the container; the volumes persist.
- `--build` builds this checkout with Docker Buildx, loads the image, creates a
  uniquely named test instance on host loopback, waits for the image healthcheck,
  and checks HTTP responses inside the container. Containers and volumes remain
  on success or failure for inspection. It never publishes an image or replaces
  another instance.

All deployment inputs are explicit CLI flags. Both modes require `--host-user`,
`--host-uid`, `--host-gid`, `--host-home` and `--ssh-agent-socket`. There is no
fallback to host `SSH_AUTH_SOCK`, `SUDO_USER`, `HOSTNAME`, `USER`, `HOME` or exported
`HOST_*` configuration. Optional `--host-name NAME` defaults to unset.

The selected agent is mounted at the same absolute path in DevHarbour. The script
sets the standard `SSH_AUTH_SOCK` variable inside the container from the socket
argument. Startup checks agent connectivity as the non-root operator. This
internal environment variable is not an implicit launcher input.

Common flags:

| Flag                                             | Meaning                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--host-user NAME`                               | Required non-root Docker-host operator name.                                                                                                     |
| `--host-uid UID`                                 | Required Docker-host operator UID.                                                                                                               |
| `--host-gid GID`                                 | Required Docker-host operator primary GID.                                                                                                       |
| `--host-home PATH`                               | Required canonical absolute Docker-host operator home.                                                                                           |
| `--ssh-agent-socket PATH`                        | Required existing Docker-host SSH agent socket.                                                                                                  |
| `--host-name NAME`                               | Optional host label; defaults to unset, not host HOSTNAME.                                                                                       |
| `--workspace PATH`                               | Workspace bind, source and target identical. Registry default `HOST_HOME/ddash-workspace`, build default `HOST_HOME/ddash-production-workspace`. |
| `--socket PATH`                                  | Docker-host socket (default `/var/run/docker.sock`).                                                                                             |
| `--port N`                                       | Published host port (registry default 3000, build default 3001).                                                                                 |
| `--bind-address ADDR`                            | Registry-mode publication address (default `127.0.0.1`). Build mode stays loopback-only.                                                         |
| `--origin URL`                                   | External HTTP(S) origin, forwarded only when set.                                                                                                |
| `--password VALUE`                               | Explicit password (visible in process lists; prefer the file or prompt).                                                                         |
| `--password-file PATH`                           | Read the password from a file, trimming one trailing newline.                                                                                    |
| `--env-file PATH`                                | Extend the container environment from a Docker env file; repeatable in both modes.                                                               |
| `--bootstrap`                                    | Enable the dev-bootstrap startup hook. Omit the flag to keep it disabled.                                                                        |
| `--ssh-known-hosts PATH`                         | One trusted known_hosts file, mounted read-only in the dashboard. No key-directory mount.                                                        |
| `--no-create-workspace`                          | Skip local workspace creation for remote daemons.                                                                                                |
| `--non-interactive`                              | Disable all prompts; requires `--password` or `--password-file`.                                                                                 |
| `--gateway`, `--gateway-host`, `--gateway-ports` | Opt-in service-gateway passthroughs.                                                                                                             |
| `--vscode-ssh-host VALUE`                        | `VSCODE_SSH_HOST` passthrough.                                                                                                                   |
| `--image REF`                                    | Registry mode only: image reference.                                                                                                             |
| `--platform`, `--name`, `--health-timeout`       | Build mode only. Cross-mode flags fail with clear errors.                                                                                        |

`--no-bootstrap`, `--ssh-dir` and `--no-ssh-dir` have been removed. They fail with
migration guidance rather than silently changing behavior. `--help` needs none
of the required deployment arguments.

Example with literal values (replace them with your actual host values):

```bash
bash scripts/run-dashboard.sh --build \
  --host-user axel --host-uid 1000 --host-gid 1000 --host-home /home/axel \
  --ssh-agent-socket /run/user/1000/ssh-agent.socket \
  --host-name development-host \
  --workspace /home/axel/git.workspaces
```

Callers may choose to expand values explicitly, such as
`--ssh-agent-socket "$SSH_AUTH_SOCK"`. The launcher itself never reads that host
variable. Missing arguments fail even when the old host variables are set.

`tern-dev-bootstrap.sh` lives in `plugins/` in the repository. The Dockerfile copies
it to `/opt/dashboard/plugins/`, and the entrypoint selects bundled hooks from
that directory; operator-supplied hooks stay under `/docker-entrypoint.d/`. The
hook command interface is unchanged: `docker run image dev-bootstrap`.

## Additional container environment

Use `--env-file` to provide variables that `devcontainer.json` references through
`${localEnv:NAME}`. The Dev Containers CLI runs inside the dashboard container,
so its local environment is the dashboard's environment, not the Docker host's.
The existing terminal environment filter still removes dashboard credentials,
`VSCODE_*` variables and editor launch hooks from child processes.

```bash
bash scripts/run-dashboard.sh --build \
  --host-user axel --host-uid 1000 --host-gid 1000 --host-home /home/axel \
  --ssh-agent-socket /run/user/1000/ssh-agent.socket \
  --env-file /home/axel/.config/devcontainer-dashboard/development.env
```

Example file:

```text
GITLAB_USER=operator
ARTIFACT_REPOSITORY=https://artifacts.example.test
```

The file is read by the Docker client on the machine running the launcher. It is
not a Docker-host bind source, mounted into the container, or passed to the image
build. Relative paths resolve from the launcher's initial working directory,
including in build mode. Paths with spaces are supported when quoted.
Missing, unreadable and non-regular files fail before prompts or Docker calls.

Docker parses the file: use `NAME=value`, blank lines and `#` comment lines.
Values are literal, not shell expressions: do not use `export`, shell quoting,
command substitution or `${...}` expansion. A bare `NAME` asks Docker to copy
that variable from the Docker client's exported environment. Prefer explicit
`NAME=value` entries for reproducibility. The launcher never sources the file.

Repeat `--env-file` to layer files in argument order; later files take precedence.
Explicit container environment entries generated by the launcher take precedence
over all files, including the password, required identity, workspace root,
selected agent socket and optional host-name label. An env file cannot supply or
replace required launcher arguments. Variables without a launcher-generated
override can change application behavior, so review the file as trusted runtime
configuration.

Protect files that contain secrets and keep them out of version control. The
launcher does not print file contents or put their values into Docker arguments,
but Docker stores container environment values in its metadata. Dashboard
operators, container processes and Docker administrators can access them. Child
commands can also print them; this feature is not a secret store. Recreate the
container after changing an env file; restarting it does not reload the file.

## Identity and resources

Supply all four `--host-user`, `--host-uid`, `--host-gid` and `--host-home` values.
There is no automatic account selection, including under sudo. Root UID/GID,
missing/partial identity, system home paths, traversal and noncanonical home
spellings are rejected. The entrypoint also checks actual home symlinks and
account collisions inside the container.

For remote daemons and launchers inside another container, arguments must describe
the Docker host. Do not assume the launcher's filesystem is the daemon host's
filesystem. Use `--no-create-workspace` to avoid local directory creation and
provision the workspace on the daemon host separately. This flag does not add
remote-daemon support to the application: it still needs a host Unix socket
mounted at `/var/run/docker.sock`. `--socket` selects that bind source. The SSH
agent contract requires an actual daemon-host source path too, not a socket
private to an outer VS Code container.

Workspace paths stay identical on both sides. Docker `--mount` rejects missing
bind sources on the daemon host. No SSH directory is created to satisfy a mount.
Local directory existence is not used as proof that a remote daemon can bind it.
Docker's diagnostic identifies its missing source; build mode adds guidance when
container creation fails.

Keep `/data` and `/dashboard-history` for dashboard-owned named volumes only.
Keep the existing volume names when upgrading. Do not mount a host workspace,
SSH directory or home under these storage targets. The home itself is private to
the container; selected resource subdirectories can be mounted read-only.

## Bootstrap and SSH

Bootstrap is off by default. Add `--bootstrap` to enable the bundled hook; omit it
to disable. Every run prints `dev-bootstrap: 0` or `1`. There is no negative
bootstrap flag.

Pass the existing Docker-host agent with `--ssh-agent-socket PATH`. The entrypoint
verifies it as the operator before running hooks. A reachable agent with no loaded
identities is permitted; missing or inaccessible agents are not. Private keys and
the host `.ssh` directory are never mounted by the launcher.

```bash
bash scripts/run-dashboard.sh --build --bootstrap \
  --host-user axel --host-uid 1000 --host-gid 1000 --host-home /home/axel \
  --ssh-agent-socket /run/user/1000/ssh-agent.socket \
  --ssh-known-hosts /home/axel/.ssh/known_hosts
```

`--ssh-known-hosts` mounts only that trusted file at `/etc/ssh/ssh_known_hosts` in
the dashboard. It provides host-key trust for dashboard Git/bootstrap, not managed
devcontainers automatically. Supply trust separately in their images or explicit
known_hosts-only configuration. Default bootstrap SSH uses BatchMode and strict
host-key checking. Do not trust unauthenticated keyscan output.

Build/rebuild actions forward the same selected agent into the devcontainer,
set container and remote environments, and verify access as its remote user.
The target image needs a POSIX shell and `ssh-add`. Existing containers require
an explicit rebuild to add a socket mount. No socket permissions are changed.
Changing the socket path requires recreation, not rebuilding the dashboard image.
Same-path restart/remount behavior after inode replacement still needs runtime
validation. See [SSH-AGENT.md](../SSH-AGENT.md) for the full contract and checklist.

Use an available port. Build mode creates a new instance, not an update to the
old one. The selected hook fails startup if credentials are unavailable, cloning
fails, the installer is broken, or no shim is installed. An existing checkout is
reinstalled and can require GitLab access because its installer performs a pull.
Host SSH files are never rewritten. The provider installer creates
`~/.local/bin/devbootstrap`; the entrypoint includes that directory on PATH for
hooks, the server, terminals and builds.

Bootstrap resides in the container-private home, not a named volume. A newly
created container needs installation again. Do not assume a previous container's
writable layer or an old `/home/ddash/.devbootstrap` was migrated. Keep old
containers until you have preserved required state.

## Unattended use

`--non-interactive` disables all prompts and requires `--password` or
`--password-file`. Identity and socket arguments are still required. The workspace
then defaults per mode without prompting; the registry-mode prompt only runs when
a terminal is available and `--workspace` was not given. `--origin` accepts an
HTTP(S) origin without paths, credentials or invalid ports; leave it unset for
local HTTP. Service-gateway passthroughs are forwarded only when flags are set.

```bash
bash scripts/run-dashboard.sh --non-interactive \
  --host-user axel --host-uid 1000 --host-gid 1000 --host-home /home/axel \
  --ssh-agent-socket /run/user/1000/ssh-agent.socket \
  --password-file /home/axel/.secrets/dashboard-password \
  --workspace /home/axel/ddash-workspace
```

The application grants full operator capability; these mounts are not isolation.
Agent forwarding permits authentication/signing while connected. A read-only
socket bind does not restrict that authority.

## Validation

```bash
npm run test:deployment
npm run test:ssh
npm run check
npm run lint
npm run test:unit -- --run
npm run build
npm run build:server
npm run test:production
npm run test:e2e
```

Deployment tests use mocked privileged commands and Docker calls. They cover
required identity and socket arguments, ignored ambient sudo/agent/hostname values,
the rejection matrix, password prompt and file handling, origin and gateway
validation, same-path mounts, mode violations, unattended startup, retained
resources, agent startup diagnostics and password non-disclosure. They do not
prove real privilege dropping, SSH authentication or Docker behavior. `test:ssh`
adds configuration/runner and rebuild regressions, including named configurations
and literal argv. Brain and Tailscale launcher fixtures supply the same explicit
required arguments.

`production-smoke.mjs` tests a compiled server or disposable `SMOKE_BASE_URL`. It
checks health, login, WebSocket authorization and PTY output. Optional
`SMOKE_FIXTURE_WORKSPACE` starts a devcontainer through the authenticated
dashboard build API and waits for that persistent build terminal to exit. It is
not a dry run. Fixture builds require `SMOKE_BASE_URL` and
`SMOKE_FIXTURE_CLEANUP_OWNER=external`. The caller must own sibling-container
cleanup.

`container-smoke.sh` creates its own disposable SSH agent and fixture key,
forwards the socket into the dashboard and a non-root managed devcontainer, and
checks public identities and signing. It mounts no private keys and never uses
or changes the operator's real agent. It requires a native Linux Docker host and
network access, and cleans up only its own resources. Its migration is source-
checked but still requires a recorded Docker integration run. Use the checklist
in [SSH-AGENT.md](../SSH-AGENT.md) for real end-to-end acceptance.

Record the exact revision and commands actually run. A mocked suite passing is not
a successful production build or Docker integration result. Real agent forwarding,
actual Polaris localEnv requirements, persistent-build reconnect/cancellation,
shutdown and volume migration still need appropriate runtime tests. Structured
shell arguments for build paths remain coordinated with issue #11.

## Installed DevHarbour CLI

### Installation and prerequisites

`bash scripts/install-devharbour.sh --source "$PWD"` installs the current checkout's
CLI and launcher into a versioned user-local runtime directory. `--ref COMMIT`
selects a remote GitHub revision instead of `--source`. Without either option, the
installer resolves `main` to one immutable commit before downloading its archive.
It reads only allowlisted regular runtime files from the archive rather than
extracting arbitrary archive paths. The source checkout is a separate verified
Git operation. Pinned terminal packages install into a private Python environment.

Required host tools: Linux, Python 3.9+ with venv/pip, Bash, Git and Docker. Use an
existing non-root Docker operator. Host Node.js, npm and sudo are not needed.
The installer retains a pinned checkout by default; `--no-checkout` defers the
clone until a local build is requested. Docker Buildx is needed for local builds.
Optional integrations retain their own prerequisites. The installer never
provisions Docker/Tailscale or changes host permissions.

`--bin-dir PATH` defaults to `~/.local/bin`. `--data-dir PATH` defaults to
`${XDG_DATA_HOME:-$HOME/.local/share}/devharbour` and must be private (0700).
The installer refuses to overwrite unrelated commands or symlinks. It installs
versioned runtime files and atomically publishes its own wrapper. Reinstallation
does not touch config, credentials, volumes or containers. It does not edit shell
startup files. Follow its printed PATH instruction if needed. `--version` reports
the CLI version and installed source identity; the CLI does not upgrade itself.

### Commands and precedence

```bash
devharbour [run] [configuration options]
devharbour configure [configuration options]
devharbour status
devharbour logs
devharbour stop
devharbour build --source-checkout /absolute/path/to/checkout [options]
devharbour --help
devharbour --version
```

`run` is the default. It merges explicit flags, validates the result, saves JSON,
and ensures the managed instance is ready. With no saved settings it guides setup.
With complete saved settings it asks no repeated setup questions. `configure`
uses the same validation and saving path but makes no Docker calls. It asks about
advanced settings when interactive. Supply arguments to change required values
or an existing password-file reference.

Precedence is explicit flags, then saved settings, then documented defaults.
`--env-file` replaces the saved list when supplied; repeat it to layer files in
argument order. `--clear KEY` removes an optional saved setting. An omitted flag
never disables a saved feature. Optional booleans can also be `false` in JSON.
Clearing `brain` also clears its enabling token/port/Funnel options; clearing
`brain-funnel` clears its public-port setting; clearing `tailscale-socket` clears
Tailscale-only controls and Funnel. Contradictory `brain=false` and enabling
options are rejected rather than silently enabling Brain.

All current launcher deployment settings are supported under their existing flag
names except `--password VALUE`, which is intentionally not accepted by the new
CLI. Use a hidden prompt or `--password-file`. `--build` aliases the isolated
`build` command. `--source-checkout` identifies its actual source directory;
`--platform` and `--name` remain build-only. Managed `--health-timeout` is a CLI
readiness deadline (1 to 86400 seconds), while direct build mode uses the launcher's
existing deadline. An installed command does not build from its runtime directory.
An explicit image or bind-address setting cannot be used for a checkout build;
use a separate build config. Build creates a separate test instance, does not
replace the managed instance and does not write managed last-applied state.

`status`, `logs` (last 200 lines) and `stop` require a saved config and its ownership
label. They do not require a usable saved password or agent, and never update
configuration. They reject setting changes. `--help` and `--version` need neither
Docker nor configuration. There is no automatic image refresh. A missing selected
image is pulled on creation; existing image tags are not pulled again implicitly.

### Menu-based setup and source builds

Interactive setup uses the same Questionary/prompt-toolkit approach as devbootstrap,
not a sequence of raw flag questions. Arrow keys choose, Space toggles checkboxes,
Enter accepts, Escape goes back, and Ctrl+C cancels. Saved settings open at grouped
review. Five editable steps collect run mode, host/workspace/SSH, access/login,
and optional capabilities before the final review. The sixth step applies an
approved plan. Review can jump straight to any earlier step.

Each step states its purpose and trust boundary. Host values are confirmed as a
group with a change option. Access choices are local-only (recommended), Tailscale
HTTPS, or a custom binding. Optional capabilities are checkboxes with plain-language
explanations; only selected features show configuration menus. Detailed port/path
settings are behind a separate advanced-setting menu. Invalid plans show edit
choices instead of Save/Start. Credentials remain hidden and separate from JSON.

`configure` offers save-only, never start. Save-only does not clone build source,
build images, or touch containers. Cancel/back does not persist partial answers.
Exact-container replacement/adoption is a separate default-no approval even after
setup approval. Non-interactive flags remain available and do not import the
terminal dependencies.

The one-command installer creates a versioned private Python virtual environment
with the pinned `requirements-cli.txt` dependencies. It retains a clean Git source
checkout at `source/<commit>` and records it in `SOURCE.json`; it does not install
system packages. Git and Python venv/pip are prerequisites. `--no-checkout` leaves
source acquisition until a local build is requested. Local `--source` installation
copies the current CLI files but does not reset or modify that checkout.

Choose published images or **Build locally** in the run-mode step. Local builds
can use the installed revision, `main`, or an entered branch/tag/commit. New source
is cloned into a separate revision-pinned directory; existing modified, wrong-origin
or wrong-revision checkouts are refused, never reset. Buildx uses the selected
checkout as context. An immutable built image ID is used for the same managed
instance, retained volumes, replacement review and readiness checks. Cached image
revision labels are verified before reuse; `--rebuild` opts into a new build. A
failed build happens before any existing container can be stopped or removed.

CLI equivalents for an already-complete config:

```bash
devharbour configure --non-interactive --image-source build --source-ref main
devharbour --non-interactive
# Explicit rebuild, still requiring exact-container replacement approval if changed:
devharbour --rebuild
# Switch back to the published-image mode:
devharbour configure --non-interactive --image-source published
```

`--source-checkout PATH` selects an existing clean expected-origin checkout when
managed build mode is selected; paths are resolved against the config directory.
The existing isolated `build` command / `--build` option is separate: it still
needs explicit complete settings and `--source-checkout` and creates an isolated
test instance rather than replacing the managed one.

Effective defaults: dashboard **3000**, AI **3002**, loopback **127.0.0.1**, Docker
socket **/var/run/docker.sock**, timeout **180 seconds**, restart policy **always**.
AI state is **dashboard_ai** (or **<instance>-ai**). Optional capabilities default
to off. Selected Brain uses local port **3100**. Selected public Brain Funnel uses
HTTPS port **10000** (allowed: 443, 8443, 10000). Tailscale service ports default to
**8400-8499**, with internal gateway **3003**. Disabled features do not receive
port/token values merely because those defaults exist.

To run the terminal regressions, use a private Python environment with the pinned
CLI requirements and select it for the test process:

```bash
python3 -m venv /tmp/devharbour-cli-tests
/tmp/devharbour-cli-tests/bin/python -m pip install -r scripts/requirements-cli.txt
DEVHARBOUR_TEST_PYTHON=/tmp/devharbour-cli-tests/bin/python npm run test:cli
```

The tests use disposable PTYs, Unix sockets, empty OpenSSH agents and Git fixtures;
they do not use operator keys or existing Docker resources.

#### Tailscale origin autodiscovery

In the Tailscale access step, a CLI running on the actual Docker host executes
`tailscale --socket=<selected-path> whoami --json`. It derives only the local
`Node.Name`, removes the final DNS dot, validates a device `*.ts.net` hostname,
and offers `https://<name>` for confirmation. It never uses `UserProfile.LoginName`,
a peer's DNS name, a service advertisement or the account/tailnet display name.

Older clients can fall back to
`tailscale --socket=<selected-path> status --json --peers=false`, using
`Self.DNSName` only when `BackendState` is `Running` and the node is not explicitly
offline. Disabled MagicDNS, an unauthorized machine, mismatched tailnet metadata
or an invalid hostname is not guessed around. Missing commands, socket/login
permissions, malformed JSON and timeouts produce actionable manual-entry guidance.
Raw identity output, node keys and endpoint lists are never printed or saved.

An explicit `--origin` bypasses discovery. A saved origin, including a nonstandard
HTTPS port, stays the highlighted default; the detected suggestion is a separate
choice. Remote-host setup does not query the current machine's Tailscale identity.
Jumping straight from saved review to access requires confirmation of which host
the CLI is running on before attempting local discovery.

The detected DNS name suggests HTTPS port 443 only. It does not inspect existing
Serve ports, prove certificate/HTTPS availability, or establish a route. Operators
can retain or enter a configured custom port. Discovery runs only read-only
identity/status commands with a five-second timeout each and the configured socket;
it never invokes sudo, login, up, cert, serve or funnel. The overall apply step
still has its separate existing Tailscale trust and startup behavior.

Reference: [Tailscale CLI documentation](https://tailscale.com/docs/reference/tailscale-cli).
The current CLI source also documents `whoami --json`; the status JSON format can
vary by release, so unknown shapes retain the manual path rather than inventing a
hostname.

#### Host SSH-agent discovery

Interactive setup on the local Docker host ignores `SSH_AUTH_SOCK` and does not
scan temporary `/tmp/ssh-*` session sockets. It checks the selected host UID's
stable provider paths under `/run/user/<uid>` and `/var/run/user/<uid>`: `gcr/ssh`,
`openssh_agent`, `ssh-agent.socket`, `ssh-agent`, `keyring/ssh`, and
`gnupg/S.gpg-agent.ssh`. It also checks the selected home directory's
`.ssh/agent.sock` and `.gnupg/S.gpg-agent.ssh`. These cover common provider
conventions, not every distribution or custom service.

Discovery resolves/deduplicates aliases, requires an owned Unix socket within the
selected runtime/home roots, checks Linux peer UID and process identity, and reads
a bounded SSH-agent identities response. It accepts recognized OpenSSH/GCR/GPG/
GNOME providers and existing systemd socket activation at known runtime paths.
The executable is preferred; a protected non-dumpable agent can require its kernel
process name instead. SSH daemon peers and unrecognized proxies are not auto-picked.
These checks are provider identification, not attestation against malicious code
already running as the same user.

No keys are loaded and no signing request is sent. The discovery does not create a
replacement agent or alter permissions. Connecting an existing systemd socket can
activate its already-configured host-agent service. The temporary sockets created
by SSH forwarding are never used as automatic defaults. A reachable empty agent
is shown as zero loaded identities, not mistaken for an unreachable socket.

One verified candidate is suggested for confirmation. Multiple candidates are
listed and require a choice unless the saved selection is among them. No match
means an explicit manual host path is needed; there is no forwarded-environment
fallback. Inspection of another UID, another host or an inaccessible process may
prevent discovery. Explicit `--ssh-agent-socket` values are preserved and bypass
autodiscovery. The container startup and reused-instance checks still validate the
selected agent as the configured non-root operator.

Repeat the installer to get CLI updates without overwriting configuration. Use
`devharbour configure` to revisit the wizard and socket discovery; it saves settings
without touching containers. The next run separately reviews any required
container replacement.

### Version 1 JSON schema

The default path is `${XDG_CONFIG_HOME:-$HOME/.config}/devharbour/config.json`.
Override it with `--config PATH` on any command. The four top-level fields below are
required. An optional `source` object selects managed image preparation; unknown
fields, unknown setting keys and unsupported versions fail.

```json
{
	"schemaVersion": 1,
	"instanceName": "devcontainer-dashboard",
	"restartPolicy": "always",
	"settings": {
		"host-user": "operator",
		"host-uid": 1000,
		"host-gid": 1000,
		"host-home": "/home/operator",
		"ssh-agent-socket": "/run/user/1000/ssh-agent.socket",
		"workspace": "/home/operator/workspaces",
		"password-file": "dashboard-password",
		"port": 3000,
		"bootstrap": false,
		"env-file": ["development.env"]
	}
}
```

Optional source metadata (existing schema-1 configs without it remain valid):

```json
"source": {
  "mode": "build",
  "ref": "main",
  "checkout": "/home/operator/.local/share/devharbour/source/<commit>",
  "revision": "<full 40-character commit SHA>"
}
```

`mode` is `published` or `build`. `ref` is the requested Git ref. Successful source
preparation records `checkout` and resolved `revision`; future runs stay pinned.
`--source-ref REF` explicitly clears the old resolution to request another ref.
All source fields are non-secret metadata. Existing checkout origins/content and
revisions are verified before building. Managed local images save their immutable
image ID in `settings.image` after successful build, before the instance lifecycle.

- `schemaVersion` is the integer `1`.
- `instanceName` is an immutable lowercase container name (letters, digits, dot,
  underscore or hyphen; 1 to 80 characters, starting with a letter or digit).
  Select a new config and instance name for an extra instance.
- `restartPolicy` is `always`, `unless-stopped`, `on-failure` or `no`. The default
  `always` matches the policy proposed in PR #43. With `always`, a manual stop does
  not keep an instance stopped through Docker restart. The direct launcher remains
  unchanged outside its new managed path; coordinate PR #43 when it merges.
- `settings` uses launcher flag names without `--`. Ports, UID/GID and readiness
  timeout are JSON integers, optional switches are booleans, `env-file` is a list
  of strings, and the remaining settings are nonempty strings. Required settings
  are host-user, host-uid, host-gid, host-home, ssh-agent-socket and password-file.
  Launcher validators enforce actual ranges, origins and feature combinations.
- Defaults are dashboard port 3000, AI port 3002, loopback binding, the existing
  `latest` image reference and `/var/run/docker.sock`. Workspace defaults to
  `host-home/ddash-workspace` (the separate build default uses
  `ddash-production-workspace`). Advanced integrations are off by default.

Relative file and bind-source paths resolve against the config directory, not the
shell's current directory. They are not shell expressions; `~`, `$VAR` and command
substitutions are not expanded. An absolute Docker-host path names a path on that
host even when the CLI runs elsewhere. Password/env files are client-local inputs;
agent, known_hosts, workspace, Docker, Tailscale and Brain-token binds are host
inputs. The application still requires the supported Docker-host socket model;
this CLI does not add generic remote-daemon support. Guided setup defaults to this machine, but still asks the operator to confirm
the host identity values before passing them explicitly to the launcher. For another host it disables local workspace creation.

### Private files and unattended use

Config directories must be owned by the CLI user, non-symlink directories and mode 0700. Config, lock, last-applied state and password files are private (0600).
Existing insecure files/directories fail with guidance; the CLI does not chmod
unrelated host paths. Config writes are atomic and synced, and a per-config lock
rejects concurrent CLI updates. Failed validation/cancelled setup preserves prior
configuration. Never hand-edit files while the CLI is running.

Password values and Brain tokens are never written to configuration JSON. Guided
password entry uses a hidden terminal prompt and writes a separate private file
only after validation and approval. Env files are trusted Docker runtime inputs,
not a secret store. Protect them separately. Docker administrators and privileged
container processes can still inspect runtime environment values.

Prepare a private password file, then supply explicit settings:

```bash
install -d -m 700 "$HOME/.config/devharbour"
# Create dashboard-password here with mode 0600 using your preferred secure editor.
devharbour --non-interactive \
  --host-user operator --host-uid 1000 --host-gid 1000 \
  --host-home /home/operator \
  --ssh-agent-socket /run/user/1000/ssh-agent.socket \
  --workspace /home/operator/workspaces \
  --password-file dashboard-password
```

`--non-interactive` never opens a terminal. Missing required inputs or approval
fail instead. `--allow-exposure` explicitly approves a newly enabled remote
bind/origin, Tailscale socket or public Brain Funnel configuration. Those remain
opt-in. No container receives a Brain grant during CLI setup. A saved agent socket
is revalidated as the configured operator, including supplementary groups, on
reuse. Empty agents and unreachable agents have different diagnostics. Update a
stale socket path explicitly; no replacement agent, permission relaxation or
private-key mount is used.

### Container ownership, replacement and adoption

The CLI labels the container with a hash of its absolute config path and a desired
configuration fingerprint. The fingerprint also includes password/env-file
content hashes so changed credentials require reconfiguration. It never includes
plaintext values in labels or output. Moving/copying a config does not implicitly
transfer ownership. A healthy unchanged instance is left running, and a stopped
unchanged instance is started rather than recreated.

Recreation displays field-level changes and changed input-file paths, then asks
for approval. `--replace` is explicit unattended authorization for the exact owned
container, not for another installation. The CLI verifies the container identity
again before stopping/removing it, does not remove volumes, and refuses volumes
attached to other containers. Writable-layer data is lost during replacement.
Image-pull/startup failures after replacement can leave no running instance;
retained volumes remain for recovery. This is not transactional deployment or
rollback. Config is saved before deployment, and a failure says so without claiming
readiness. `<config>.state.json` records last-applied settings only after the
production readiness, Docker socket and SSH-agent checks succeed.

An unlabelled legacy container is not silently adopted. To adopt it, review its
name, image and mounts, then explicitly use `--adopt --replace`. Its `/data`,
`/dashboard-history` and `/dashboard-ai` named-volume mappings must match the
requested instance exactly. Retained orphan volumes also need explicit adoption;
use `--adopt` with a terminal approval, or `--adopt --replace` unattended. Volumes
attached to another container are refused even with adoption. The default instance
preserves `dashboard_data`, `ddash_zsh_data` and `dashboard_ai`; extra named
instances use `<name>-data`, `<name>-history` and `<name>-ai`. An explicit
`ai-state-volume` retains the existing launcher override.

The CLI does not provision host boot ordering, auto-update an image/CLI, delete
installation data, or silently rebuild a devcontainer. Existing direct launcher
flags remain supported. The new `--validate-only` path checks explicit settings
without reading credentials, creating workspaces, prompting or accessing Docker.
The `--managed-*` options are integration arguments for the CLI: they reuse the
same argument builder and refuse an existing container name.

### Validation limits

Run `npm run test:cli` for isolated config, installer, PTY, failure-path and mocked
Docker regressions. The suite requires Python 3.9+, Bash, util-linux `script`, and
OpenSSH `ssh-agent` for an empty disposable agent fixture; it never uses the
operator's agent or keys. Discovery tests also use disposable Unix sockets with
controlled peer-provider metadata. These do not prove real Docker mounts, SSH authentication,
image compatibility, production WebSockets or restart behavior. Real-Docker
acceptance must use disposable resources, never existing operator data.
