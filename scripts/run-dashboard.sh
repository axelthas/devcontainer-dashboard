#!/bin/bash
# Run the dashboard: pull the published image, or build and verify this checkout.
#
# Usage: bash scripts/run-dashboard.sh [options]; supports standalone curl | bash.
# Requires Bash, Docker and access to the selected Docker-host Unix socket.
# Registry mode (default) pulls the selected image and runs it attached in the
# foreground with the stable dashboard_data and ddash_zsh_data volumes; Ctrl+C
# stops the container and keeps those volumes. Build mode (--build) builds the
# current checkout with Buildx, starts a unique detached test instance on host
# loopback, waits for the image healthcheck and verifies HTTP responses; the
# container and its per-run volumes remain for inspection on any failure.
# All inputs are flags. The launcher reads no deployment environment besides an
# exported SSH_AUTH_SOCK (forwarded read-only) and SUDO_USER (identity under
# sudo). The selected image has full operator access to the Docker daemon.
# Bind paths must exist on the Docker host; --mount does not create them.
# See scripts/README.md for the full flag grammar and host-path contract.

set -euo pipefail

# Print an actionable error to stderr and exit unsuccessfully. All callers stop the script.
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Print flags, modes, defaults and credential handling without using Docker, identity or secrets.
usage() {
  cat <<'HELP'
Usage: bash scripts/run-dashboard.sh [options]
Runs the production dashboard. Registry mode (default) pulls the published image
and runs it in the foreground; Ctrl+C stops the container, named volumes persist.
Build mode builds this checkout and verifies a disposable test instance.

Options:
  --workspace PATH         Bind source and target for the workspace tree.
                           Default: $HOST_HOME/ddash-workspace (registry mode),
                           $HOST_HOME/ddash-production-workspace (build mode).
                           Registry mode prompts for it when interactive.
  --socket PATH            Docker-host socket mounted at /var/run/docker.sock
                           (default: /var/run/docker.sock).
  --port N                 Published host port. Default: 3000 (registry), 3001 (build).
  --bind-address ADDR      Registry-mode publication address (default: 127.0.0.1).
                           Build mode always publishes host loopback only.
  --origin URL             External HTTP(S) origin, forwarded only when set.
                           No path, credentials, or invalid ports.
  --password VALUE         Dashboard password. Visible in process lists on the
                           invoking host: prefer --password-file or the prompt.
  --password-file PATH     Read the password from PATH, trimming one trailing
                           newline. The value is never echoed.
  --host-user NAME         All-or-none Docker-host operator identity override.
  --host-uid UID           Without them the launcher resolves the account from
  --host-gid GID           passwd, selecting SUDO_USER under sudo.
  --host-home PATH
  --bootstrap              Enable the dev-bootstrap startup hook (default: off).
  --no-bootstrap           Explicitly keep the hook disabled.
  --ssh-dir                Mount HOST_HOME/.ssh read-only (default: off).
  --no-ssh-dir             Explicitly keep the SSH directory unmounted.
  --no-create-workspace    Skip local workspace creation for remote daemons.
  --non-interactive        Disable all prompts; requires --password or --password-file.
  --gateway                Enable the opt-in service gateway (SERVICE_PROXY_ENABLED=1).
  --gateway-host HOST      SERVICE_PROXY_HOST passthrough.
  --gateway-ports SPEC     SERVICE_PROXY_PORTS passthrough (port:http|https|off,...).
  --vscode-ssh-host VALUE  VSCODE_SSH_HOST passthrough for VS Code remote URIs.
  --image REF              Registry mode only: image reference
                           (default: ghcr.io/axelthas/devcontainer-dashboard:latest).
  --platform VALUE         Build mode only: Buildx platform, e.g. linux/amd64.
  --name NAME              Build mode only: fixed test container name.
  --health-timeout SECONDS Build mode only: readiness deadline (default: 180).
  --help, -h               Show this help.

An exported SSH_AUTH_SOCK is forwarded read-only at its original absolute path.
Build mode must run from a git checkout of this repository; it never publishes
images or replaces other instances. See scripts/README.md.
HELP
}

# Parse flags into configuration, detect the mode and reject cross-mode options.
# Help returns immediately so it needs no daemon, identity or credentials.
parse_arguments() {
  MODE=registry
  SHOW_HELP=0
  WORKSPACE='' SOCKET='' PORT='' BIND_ADDRESS='' ORIGIN=''
  PASSWORD='' PASSWORD_FILE=''
  HOST_USER='' HOST_UID='' HOST_GID='' HOST_HOME=''
  BOOTSTRAP=0 SSH_DIR=0 CREATE_WORKSPACE=1 NON_INTERACTIVE=0 GATEWAY=0
  GATEWAY_HOST='' GATEWAY_PORTS='' VSCODE_SSH_HOST=''
  IMAGE='' PLATFORM='' TEST_NAME='' HEALTH_TIMEOUT=''
  while (( $# )); do
    case "$1" in
      --help|-h)
        SHOW_HELP=1
        return
        ;;
      --workspace|--socket|--port|--bind-address|--origin|--password|--password-file|--host-user|--host-uid|--host-gid|--host-home|--gateway-host|--gateway-ports|--vscode-ssh-host|--image|--platform|--name|--health-timeout)
        [[ $# -ge 2 && -n "$2" ]] || fail "$1 requires a value"
        case "$1" in
          --workspace) WORKSPACE=$2 ;;
          --socket) SOCKET=$2 ;;
          --port) PORT=$2 ;;
          --bind-address) BIND_ADDRESS=$2 ;;
          --origin) ORIGIN=$2 ;;
          --password) PASSWORD=$2 ;;
          --password-file) PASSWORD_FILE=$2 ;;
          --host-user) HOST_USER=$2 ;;
          --host-uid) HOST_UID=$2 ;;
          --host-gid) HOST_GID=$2 ;;
          --host-home) HOST_HOME=$2 ;;
          --gateway-host) GATEWAY_HOST=$2 ;;
          --gateway-ports) GATEWAY_PORTS=$2 ;;
          --vscode-ssh-host) VSCODE_SSH_HOST=$2 ;;
          --image) IMAGE=$2 ;;
          --platform) PLATFORM=$2 ;;
          --name) TEST_NAME=$2 ;;
          --health-timeout) HEALTH_TIMEOUT=$2 ;;
        esac
        shift 2
        ;;
      --bootstrap) BOOTSTRAP=1; shift ;;
      --no-bootstrap) BOOTSTRAP=0; shift ;;
      --ssh-dir) SSH_DIR=1; shift ;;
      --no-ssh-dir) SSH_DIR=0; shift ;;
      --no-create-workspace) CREATE_WORKSPACE=0; shift ;;
      --non-interactive) NON_INTERACTIVE=1; shift ;;
      --gateway) GATEWAY=1; shift ;;
      --build) MODE=build; shift ;;
      *) fail "Unknown option: $1 (use --help)" ;;
    esac
  done
  ORIGIN="${ORIGIN%/}"
  if [[ "$MODE" == build ]]; then
    [[ -z "$IMAGE" ]] || fail '--image is registry-mode only; --build runs the locally built image'
    [[ -z "$BIND_ADDRESS" ]] || fail '--bind-address is registry-mode only; --build publishes host loopback only'
  else
    [[ -z "$PLATFORM" && -z "$TEST_NAME" && -z "$HEALTH_TIMEOUT" ]] \
      || fail '--platform, --name and --health-timeout require --build'
  fi
}

# Return success for an empty local origin or HTTP(S) authority with an optional valid port.
# Reject paths, credentials, interpolation and out-of-range ports without printing secrets.
valid_origin() {
  local authority port
  [[ -n "$1" ]] || return 0
  [[ "$1" =~ ^https?://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[A-Fa-f0-9:]+\])(:[0-9]{1,5})?$ ]] || return 1
  # Strip the scheme first so bracketed IPv6 colons are not mistaken for a port.
  authority="${1#*://}"
  if [[ "$authority" =~ :([0-9]+)$ ]]; then
    port=$((10#${BASH_REMATCH[1]}))
    (( port >= 1 && port <= 65535 )) || return 1
  fi
  return 0
}

# Return success for comma-separated port:http|https|off pairs, mirroring the
# gateway parser so a mistyped policy fails before any container starts.
valid_gateway_ports() {
  local remainder="$1" entry
  [[ -n "$remainder" ]] || return 0
  while [[ -n "$remainder" ]]; do
    if [[ "$remainder" == *,* ]]; then
      entry="${remainder%%,*}"
      remainder="${remainder#*,}"
      # A consumed comma must be followed by another entry: reject trailing commas.
      [[ -n "$remainder" ]] || return 1
    else
      entry="$remainder"
      remainder=''
    fi
    entry="${entry,,}"
    [[ "$entry" =~ ^([1-9][0-9]{0,4}):(http|https|off)$ ]] || return 1
    (( 10#${BASH_REMATCH[1]} <= 65535 )) || return 1
  done
  return 0
}

# Resolve the intended operator from --host-* flags or passwd (SUDO_USER under sudo).
# Reject partial/invalid identities and export the complete contract for Docker.
resolve_identity() {
  local operator="${SUDO_USER:-$(id -un)}" record number
  if [[ -z "${HOST_USER:-}${HOST_UID:-}${HOST_GID:-}${HOST_HOME:-}" ]]; then
    record=$(getent passwd "$operator") ||
      fail 'Cannot resolve operator; pass --host-user, --host-uid, --host-gid and --host-home together'
    IFS=: read -r HOST_USER _ HOST_UID HOST_GID _ HOST_HOME _ <<< "$record"
  fi
  [[ -n "${HOST_USER:-}" && -n "${HOST_UID:-}" && -n "${HOST_GID:-}" && -n "${HOST_HOME:-}" ]] ||
    fail 'Set all four --host-user, --host-uid, --host-gid and --host-home values together'
  [[ "$HOST_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ && "$HOST_USER" != root ]] || fail 'Invalid --host-user'
  for number in "$HOST_UID" "$HOST_GID"; do
    [[ "$number" =~ ^[1-9][0-9]*$ && ${#number} -le 10 ]] ||
      fail '--host-uid and --host-gid must be positive non-root IDs'
    (( number <= 2147483647 )) || fail 'Identity IDs are out of range'
  done
  [[ "$HOST_HOME" =~ ^/[a-zA-Z0-9_./\ -]+$ ]] || fail 'Invalid absolute --host-home'
  case "$HOST_HOME/" in
    /|//|*/../*|*/./*|*//*|/app/*|/data/*|/dashboard-history/*|/opt/*|/etc/*|/usr/*|/var/*|/root/*|/bin/*|/sbin/*|/dev/*|/proc/*|/sys/*|/run/*|/tmp/*)
      fail '--host-home must be a canonical dedicated non-system home path' ;;
  esac
  export HOST_USER HOST_UID HOST_GID HOST_HOME
}

# Return success when an interactive terminal is usable for prompts: either stdin
# is a terminal or /dev/tty can be opened. -w alone is not enough under CI sandboxes.
terminal_available() {
	[[ -t 0 ]] && return 0
	: </dev/tty 2>/dev/null
}

# Obtain the workspace and password from flags or the terminal without echoing secrets.
# Non-interactive runs must supply the password via --password or --password-file;
# the registry-mode workspace prompt keeps the interactive installer behavior.
read_secrets() {
  local answer
  if [[ -z "$WORKSPACE" ]]; then
    if [[ "$MODE" == registry && "$NON_INTERACTIVE" != 1 ]]; then
      terminal_available || fail 'Workspace prompt needs a terminal; use --workspace or --non-interactive'
      read -r -p "Workspace directory [$HOST_HOME/ddash-workspace]: " answer </dev/tty
      WORKSPACE="${answer:-$HOST_HOME/ddash-workspace}"
    elif [[ "$MODE" == registry ]]; then
      WORKSPACE="$HOST_HOME/ddash-workspace"
    else
      WORKSPACE="$HOST_HOME/ddash-production-workspace"
    fi
  fi
  if [[ -n "$PASSWORD" && -n "$PASSWORD_FILE" ]]; then
    fail 'Use --password or --password-file, not both'
  fi
  if [[ -z "$PASSWORD" && -n "$PASSWORD_FILE" ]]; then
    [[ -r "$PASSWORD_FILE" ]] || fail "Cannot read password file: $PASSWORD_FILE"
    IFS= read -r -d '' PASSWORD < "$PASSWORD_FILE" || true
    # Trim exactly one trailing newline, like editors that always terminate lines.
    if [[ "$PASSWORD" == *$'\n' ]]; then PASSWORD="${PASSWORD%$'\n'}"; fi
  elif [[ -z "$PASSWORD" && "$NON_INTERACTIVE" == 1 ]]; then
    fail 'Non-interactive runs require --password or --password-file'
  elif [[ -z "$PASSWORD" ]]; then
    terminal_available ||
      fail 'Password prompt needs a terminal; use --password, --password-file or --non-interactive'
    read -r -s -p 'Dashboard password: ' PASSWORD </dev/tty
    printf '\n' >/dev/tty
  fi
  [[ -n "$PASSWORD" ]] || fail 'The dashboard password must not be empty'
  export DASHBOARD_PASSWORD="$PASSWORD"
}

# Validate bind paths, ports, origin, image and passthrough values before creating resources.
# Apply per-mode defaults and reject values Docker or the gateway would misinterpret.
validate_options() {
  local value
  SOCKET="${SOCKET:-/var/run/docker.sock}"
  for value in "$WORKSPACE" "$SOCKET" "${SSH_AUTH_SOCK:-/unused}"; do
    [[ "$value" == /* && "$value" != *,* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] \
      || fail 'Bind sources must be absolute Docker-host paths without commas or newlines'
  done
  if [[ "$MODE" == registry ]]; then
    IMAGE="${IMAGE:-ghcr.io/axelthas/devcontainer-dashboard:latest}"
    BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"
    PORT="${PORT:-3000}"
  else
    PORT="${PORT:-3001}"
  fi
  [[ "$PORT" =~ ^[0-9]{1,5}$ ]] || fail '--port must be from 1 to 65535'
  PORT=$((10#$PORT))
  (( PORT >= 1 && PORT <= 65535 )) || fail '--port must be from 1 to 65535'
  [[ -z "$BIND_ADDRESS" ]] || [[ "$BIND_ADDRESS" =~ ^[]0-9A-Za-z.:_[-]{1,64}$ ]] ||
    fail 'Invalid --bind-address'
  [[ -z "$ORIGIN" ]] || valid_origin "$ORIGIN" ||
    fail 'Invalid --origin: use an HTTP(S) origin without paths, credentials or interpolation'
  [[ -z "$IMAGE" ]] || [[ "$IMAGE" =~ ^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$ ]] || fail 'Invalid --image'
  [[ -z "$TEST_NAME" ]] || [[ "$TEST_NAME" =~ ^[a-z0-9][a-z0-9_.-]{0,79}$ ]] || fail 'Invalid --name'
  [[ -z "$HEALTH_TIMEOUT" ]] || [[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]{0,4}$ ]] ||
    fail 'Invalid --health-timeout'
  for value in "$GATEWAY_HOST" "$VSCODE_SSH_HOST"; do
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] ||
      fail 'Gateway and VS Code SSH values must not contain line breaks'
  done
  [[ -z "$GATEWAY_HOST" ]] || [[ "$GATEWAY_HOST" =~ ^[]0-9A-Za-z.:_[-]{1,253}$ ]] ||
    fail 'Invalid --gateway-host'
  valid_gateway_ports "$GATEWAY_PORTS" ||
    fail 'Invalid --gateway-ports: use comma-separated port:http|https|off pairs, e.g. 9001:http,8443:https'
}

# Check daemon reachability so registry pulls fail with an actionable diagnostic.
prepare_registry() {
  docker info >/dev/null 2>&1 || fail 'Cannot access the Docker daemon; check the socket with --socket'
}

# Resolve the checkout, revision and unique test names, then check daemon and Buildx prerequisites.
# Reject an existing target name rather than replacing or stopping it.
prepare_checkout() {
  local script_dir
  [[ -n "${BASH_SOURCE[0]:-}" ]] || fail 'Build mode must run from a checkout file, not curl | bash'
  script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
  REPO_ROOT=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) ||
    fail 'Build mode requires a git checkout of this repository; run the script from a clone'
  cd -- "$REPO_ROOT"
  [[ -f Dockerfile ]] || fail "No Dockerfile at checkout root: $REPO_ROOT"
  REVISION=$(git rev-parse HEAD)
  BRANCH=$(git symbolic-ref --quiet --short HEAD || printf 'detached HEAD')
  DIRTY=false
  [[ -z "$(git status --porcelain --untracked-files=normal)" ]] || DIRTY=true
  HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
  TEST_NAME="${TEST_NAME:-ddash-local-${REVISION:0:12}-$(date +%s)-$$}"
  IMAGE="devcontainer-dashboard:$TEST_NAME"
  docker info >/dev/null || fail 'Cannot access the Docker daemon'
  docker buildx version >/dev/null || fail 'Docker Buildx is required'
  if docker container inspect "$TEST_NAME" >/dev/null 2>&1; then
    fail "Container already exists: $TEST_NAME"
  fi
}

# Assemble the docker argv shared by both modes: identity, secrets, binds and selected options.
# Preserve argument boundaries; keep bind sources and targets identical on both sides.
prepare_arguments() {
  if [[ "$CREATE_WORKSPACE" == 1 ]]; then mkdir -p -- "$WORKSPACE"; fi
  ARGS=(--env DASHBOARD_PASSWORD --env HOST_USER --env HOST_UID --env HOST_GID --env HOST_HOME
    --env "WORKSPACE_ROOT=$WORKSPACE" --env "HOST_HOSTNAME=${HOSTNAME:-}"
    --mount "type=bind,source=$WORKSPACE,target=$WORKSPACE"
    --mount "type=bind,source=$SOCKET,target=/var/run/docker.sock")
  # adapter-node rejects an empty ORIGIN at startup, so only forward a configured origin.
  [[ -z "$ORIGIN" ]] || ARGS+=(--env "ORIGIN=$ORIGIN")
  if [[ "$GATEWAY" == 1 ]]; then ARGS+=(--env "SERVICE_PROXY_ENABLED=1"); fi
  # The service gateway is opt-in; forward its configuration only when the flags set it.
  [[ -z "$GATEWAY_HOST" ]] || ARGS+=(--env "SERVICE_PROXY_HOST=$GATEWAY_HOST")
  [[ -z "$GATEWAY_PORTS" ]] || ARGS+=(--env "SERVICE_PROXY_PORTS=$GATEWAY_PORTS")
  [[ -z "$VSCODE_SSH_HOST" ]] || ARGS+=(--env "VSCODE_SSH_HOST=$VSCODE_SSH_HOST")
  if [[ -n "${SSH_AUTH_SOCK:-}" ]]; then
    export SSH_AUTH_SOCK
    ARGS+=(--env SSH_AUTH_SOCK --mount "type=bind,source=$SSH_AUTH_SOCK,target=$SSH_AUTH_SOCK,readonly")
  fi
  if [[ "$SSH_DIR" == 1 ]]; then
    ARGS+=(--mount "type=bind,source=$HOST_HOME/.ssh,target=$HOST_HOME/.ssh,readonly")
  fi
  HOOK=()
  if [[ "$BOOTSTRAP" == 1 ]]; then HOOK=(dev-bootstrap); fi
  if [[ "$MODE" == build ]]; then
    BUILD_ARGS=(--load --progress=plain --tag "$IMAGE"
      --label "org.opencontainers.image.revision=$REVISION"
      --label "devcontainer-dashboard.local-changes=$DIRTY")
    if [[ -n "$PLATFORM" ]]; then
      BUILD_ARGS+=(--platform "$PLATFORM")
      ARGS+=(--platform "$PLATFORM")
    fi
  fi
}

# Print the reviewed operator, hook mode and bind contract without printing credentials.
print_plan() {
  if [[ "$MODE" == build ]]; then
    printf 'Source: %s at %s (local changes: %s)\n' "$BRANCH" "$REVISION" "$DIRTY"
  fi
  printf 'Operator: %s (%s:%s), home %s\n' "$HOST_USER" "$HOST_UID" "$HOST_GID" "$HOST_HOME"
  printf 'dev-bootstrap: %s (1=enabled, 0=disabled)\n' "$BOOTSTRAP"
  echo 'All bind sources must exist on the Docker host. SSH resources are read-only.'
}

# Pull the image and run it attached in the foreground; Ctrl+C stops the container.
# The stable data/history volumes persist; --rm removes the container on exit.
run_registry() {
  docker pull "$IMAGE"
  printf 'Dashboard address: http://%s:%s\n' "$BIND_ADDRESS" "$PORT"
  echo 'Ctrl+C stops the container; the dashboard_data and ddash_zsh_data volumes persist.'
  exec docker run --rm "${ARGS[@]}" \
    --volume dashboard_data:/data --volume ddash_zsh_data:/dashboard-history \
    --publish "$BIND_ADDRESS:$PORT:3000" \
    --name devcontainer-dashboard "$IMAGE" "${HOOK[@]}"
}

# Build the checkout, start a unique detached instance and wait for verified readiness.
# On any failure print diagnostics and retain the container and volumes for inspection.
run_build() {
  printf 'Test container name: %s\nImage: %s\n' "$TEST_NAME" "$IMAGE"
  docker buildx build "${BUILD_ARGS[@]}" .
  docker run --detach "${ARGS[@]}" \
    --volume "$TEST_NAME-data:/data" --volume "$TEST_NAME-zsh:/dashboard-history" \
    --publish "127.0.0.1:$PORT:3000" \
    --name "$TEST_NAME" "$IMAGE" "${HOOK[@]}" ||
    fail "Container creation failed. Check daemon-host bind sources, socket access and port availability; --mount does not create missing sources."
  printf 'Retained volumes: %s-data %s-zsh\n' "$TEST_NAME" "$TEST_NAME"
  printf 'Logs: docker logs -f %s\nStop: docker stop %s\nResume: docker start %s\n' \
    "$TEST_NAME" "$TEST_NAME" "$TEST_NAME"
  wait_for_readiness
}

# Run bounded readiness and unauthenticated-access checks inside the built container.
# Return failure if either HTTP status differs from the expected production contract.
verify_http() {
  docker exec "$TEST_NAME" node -e '
    const http = require("node:http");
    const check = (path, expected) => new Promise((resolve, reject) => {
      const r = http.get({host:"127.0.0.1",port:3000,path}, s => {
        s.resume(); s.statusCode === expected ? resolve() : reject(new Error(path+": "+s.statusCode));
      });
      r.setTimeout(3000, () => r.destroy(new Error("HTTP timeout")));
      r.on("error", reject);
    });
    Promise.all([check("/healthz",200),check("/api/containers",401)])
      .catch(e => { console.error(e.message); process.exitCode = 1; });
  '
}

# Poll container state and image health until the deadline, then verify HTTP behavior.
# On failure print diagnostics and retain the container/volumes instead of cleaning evidence.
wait_for_readiness() {
  # SECONDS is Bash elapsed time; a wall-clock adjustment must not extend this wait.
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) state health
  while (( SECONDS < deadline )); do
    state=$(docker inspect --format '{{.State.Status}}' "$TEST_NAME")
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$TEST_NAME")
    [[ "$state" == running ]] || break
    if [[ "$health" == healthy ]]; then
      verify_http || fail 'HTTP checks failed; container and volumes retained for inspection'
      printf 'Ready: http://127.0.0.1:%s\n' "$PORT"
      [[ -z "$ORIGIN" ]] || printf 'External origin: %s\n' "$ORIGIN"
      echo 'Log in and verify terminal output. Nothing was published.'
      return
    fi
    [[ "$health" != none && "$health" != unhealthy ]] || break
    sleep 2
  done
  docker logs "$TEST_NAME" >&2 || true
  docker inspect --format '{{json .State.Health}}' "$TEST_NAME" >&2 || true
  fail 'Application did not become healthy; container and volumes retained for inspection'
}

# Run the script phases in order. Stop on a failed phase before later work can start.
main() {
  parse_arguments "$@"
  if [[ "$SHOW_HELP" == 1 ]]; then
    usage
    return
  fi
  resolve_identity
  read_secrets
  validate_options
  if [[ "$MODE" == build ]]; then
    prepare_checkout
  else
    prepare_registry
  fi
  prepare_arguments
  print_plan
  if [[ "$MODE" == build ]]; then
    run_build
  else
    run_registry
  fi
}

main "$@"