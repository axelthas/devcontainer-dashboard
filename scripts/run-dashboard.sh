#!/bin/bash
# Run the dashboard: pull the published image, or build and verify this checkout.
# Explicit flags are the only deployment inputs. Tailscale mode is Linux-only,
# uses host networking, and keeps the dashboard and service gateway on loopback.
# Named volumes persist. The selected image has full Docker operator access.
set -euo pipefail

# Stop before starting later phases.
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Print the complete flag grammar without daemon access or credentials.
usage() {
  cat <<'HELP'
Usage: bash scripts/run-dashboard.sh [options]
Registry mode pulls and runs attached; build mode verifies this checkout.
Options:
  --workspace PATH         Workspace bind (same source and target).
  --socket PATH            Docker socket (default /var/run/docker.sock).
  --port N                 Host port (default 3000 registry, 3001 build).
  --bind-address ADDR      Registry only (default 127.0.0.1).
  --origin URL             Exact external HTTP(S) origin.
  --password VALUE         Visible in process lists; prefer file or prompt.
  --password-file PATH     Read password, trim one trailing newline.
  --env-file PATH          Extend container environment (Docker syntax; repeatable).
  --host-user NAME         All four identity values must be supplied together.
  --host-uid UID
  --host-gid GID
  --host-home PATH
  --bootstrap              Enable dev-bootstrap hook (default off).
  --no-bootstrap           Keep hook disabled.
  --ssh-dir                Mount HOST_HOME/.ssh read-only.
  --no-ssh-dir             Keep SSH directory unmounted.
  --no-create-workspace    Skip local workspace creation.
  --non-interactive        Disable prompts; password input required.
  --gateway                Enable existing path service gateway.
  --gateway-host HOST      Path gateway upstream host.
  --gateway-ports SPEC     Shared service policy (port:http|https|off,...).
  --tailscale-socket PATH  Opt in to automatic HTTPS service ports.
                           Linux Docker host only; grants broad tailscaled control.
                           Uses host networking; listeners remain loopback-only.
                           Requires --origin https://node.tailnet.ts.net.
  --tailscale-ports A-B    HTTPS Serve range (default 8400-8499, max 256 ports).
  --tailscale-gateway-port N
                           Host-loopback proxy listener (default 3003).
  --vscode-ssh-host VALUE  VS Code SSH host.
  --image REF              Registry image (default ghcr.io/axelthas/devcontainer-dashboard:latest).
  --build                  Build and run this checkout; never publish an image.
  --platform VALUE         Buildx platform (build only).
  --name NAME              Test container name (build only).
  --health-timeout SECONDS Readiness deadline (build only, default 180).
  --help, -h               Show help.

SSH_AUTH_SOCK is forwarded read-only when exported. SUDO_USER selects the operator
under sudo. Other deployment environment variables are ignored.
HELP
}

# Parse flags and reject mode conflicts before reading secrets or touching Docker.
parse_arguments() {
  MODE=registry SHOW_HELP=0
  WORKSPACE='' SOCKET='' PORT='' BIND_ADDRESS='' ORIGIN=''
  PASSWORD='' PASSWORD_FILE='' HOST_USER='' HOST_UID='' HOST_GID='' HOST_HOME=''
  ENV_FILES=()
  BOOTSTRAP=0 SSH_DIR=0 CREATE_WORKSPACE=1 NON_INTERACTIVE=0 GATEWAY=0
  GATEWAY_HOST='' GATEWAY_PORTS='' VSCODE_SSH_HOST=''
  IMAGE='' PLATFORM='' TEST_NAME='' HEALTH_TIMEOUT=''
  TAILSCALE_SOCKET='' TAILSCALE_PORTS='' TAILSCALE_GATEWAY_PORT=''
  while (( $# )); do
    case "$1" in
      --help|-h) SHOW_HELP=1; return ;;
      --workspace|--socket|--port|--bind-address|--origin|--password|--password-file|--env-file|--host-user|--host-uid|--host-gid|--host-home|--gateway-host|--gateway-ports|--vscode-ssh-host|--image|--platform|--name|--health-timeout|--tailscale-socket|--tailscale-ports|--tailscale-gateway-port)
        [[ $# -ge 2 && -n "$2" ]] || fail "$1 requires a value"
        case "$1" in
          --workspace) WORKSPACE=$2 ;;
          --socket) SOCKET=$2 ;;
          --port) PORT=$2 ;;
          --bind-address) BIND_ADDRESS=$2 ;;
          --origin) ORIGIN=$2 ;;
          --password) PASSWORD=$2 ;;
          --password-file) PASSWORD_FILE=$2 ;;
          --env-file) ENV_FILES+=("$2") ;;
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
          --tailscale-socket) TAILSCALE_SOCKET=$2 ;;
          --tailscale-ports) TAILSCALE_PORTS=$2 ;;
          --tailscale-gateway-port) TAILSCALE_GATEWAY_PORT=$2 ;;
        esac
        shift 2 ;;
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
    [[ -z "$PLATFORM" && -z "$TEST_NAME" && -z "$HEALTH_TIMEOUT" ]] ||
      fail '--platform, --name and --health-timeout require --build'
  fi
}

# Resolve client-side files before build mode changes directory. Never source them.
validate_env_files() {
  local index path directory
  for index in "${!ENV_FILES[@]}"; do
    path="${ENV_FILES[$index]}"
    [[ -f "$path" && -r "$path" ]] || fail 'Each --env-file must be a readable regular file'
    directory=$(cd -- "$(dirname -- "$path")" && pwd -P) ||
      fail 'Cannot resolve --env-file directory'
    ENV_FILES[$index]="$directory/$(basename -- "$path")"
  done
}

# Accept exact origins, including bracketed IPv6, but reject paths and credentials.
valid_origin() {
  local authority port
  [[ -n "$1" ]] || return 0
  [[ "$1" =~ ^https?://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[A-Fa-f0-9:]+\])(:[0-9]{1,5})?$ ]] || return 1
  authority="${1#*://}"
  if [[ "$authority" =~ :([0-9]+)$ ]]; then
    port=$((10#${BASH_REMATCH[1]}))
    (( port >= 1 && port <= 65535 )) || return 1
  fi
  return 0
}

# Mirror the server's allowed web-service protocol grammar.
valid_gateway_ports() {
  local remainder="$1" entry
  [[ -n "$remainder" ]] || return 0
  while [[ -n "$remainder" ]]; do
    if [[ "$remainder" == *,* ]]; then
      entry="${remainder%%,*}"; remainder="${remainder#*,}"
      [[ -n "$remainder" ]] || return 1
    else
      entry="$remainder"; remainder=''
    fi
    entry="${entry,,}"
    [[ "$entry" =~ ^([1-9][0-9]{0,4}):(http|https|off)$ ]] || return 1
    (( 10#${BASH_REMATCH[1]} <= 65535 )) || return 1
  done
  return 0
}

# Resolve a non-root host operator, without taking over a partial identity.
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

# Detect a usable prompt terminal even when the launcher arrives through a pipe.
terminal_available() {
  [[ -t 0 ]] && return 0
  : </dev/tty 2>/dev/null
}

# Obtain secrets without echoing them or placing them in Docker's argv.
read_secrets() {
  local answer
  if [[ -z "$WORKSPACE" ]]; then
    if [[ "$MODE" == registry && "$NON_INTERACTIVE" != 1 ]]; then
      terminal_available || fail 'Workspace prompt needs a terminal; use --workspace or --non-interactive'
      read -r -p "Workspace directory [$HOST_HOME/ddash-workspace]: " answer </dev/tty
      WORKSPACE="${answer:-$HOST_HOME/ddash-workspace}"
    elif [[ "$MODE" == registry ]]; then WORKSPACE="$HOST_HOME/ddash-workspace"
    else WORKSPACE="$HOST_HOME/ddash-production-workspace"
    fi
  fi
  if [[ -n "$PASSWORD" && -n "$PASSWORD_FILE" ]]; then fail 'Use --password or --password-file, not both'; fi
  if [[ -z "$PASSWORD" && -n "$PASSWORD_FILE" ]]; then
    [[ -r "$PASSWORD_FILE" ]] || fail "Cannot read password file: $PASSWORD_FILE"
    IFS= read -r -d '' PASSWORD < "$PASSWORD_FILE" || true
    if [[ "$PASSWORD" == *$'\n' ]]; then PASSWORD="${PASSWORD%$'\n'}"; fi
  elif [[ -z "$PASSWORD" && "$NON_INTERACTIVE" == 1 ]]; then
    fail 'Non-interactive runs require --password or --password-file'
  elif [[ -z "$PASSWORD" ]]; then
    terminal_available || fail 'Password prompt needs a terminal; use --password, --password-file or --non-interactive'
    read -r -s -p 'Dashboard password: ' PASSWORD </dev/tty
    printf '\n' >/dev/tty
  fi
  [[ -n "$PASSWORD" ]] || fail 'The dashboard password must not be empty'
  export DASHBOARD_PASSWORD="$PASSWORD"
}

# Reject malformed bind sources, options and port policies before resource creation.
validate_options() {
  local value first last external
  SOCKET="${SOCKET:-/var/run/docker.sock}"
  for value in "$WORKSPACE" "$SOCKET" "${SSH_AUTH_SOCK:-/unused}" "${TAILSCALE_SOCKET:-/unused}"; do
    [[ "$value" == /* && "$value" != *,* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] ||
      fail 'Bind sources must be absolute Docker-host paths without commas or newlines'
  done
  if [[ "$MODE" == registry ]]; then
    IMAGE="${IMAGE:-ghcr.io/axelthas/devcontainer-dashboard:latest}"
    BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"; PORT="${PORT:-3000}"
  else PORT="${PORT:-3001}"
  fi
  [[ "$PORT" =~ ^[0-9]{1,5}$ ]] || fail '--port must be from 1 to 65535'
  PORT=$((10#$PORT))
  (( PORT >= 1 && PORT <= 65535 )) || fail '--port must be from 1 to 65535'
  [[ -z "$BIND_ADDRESS" ]] || [[ "$BIND_ADDRESS" =~ ^[]0-9A-Za-z.:_[-]{1,64}$ ]] || fail 'Invalid --bind-address'
  [[ -z "$ORIGIN" ]] || valid_origin "$ORIGIN" || fail 'Invalid --origin'
  [[ -z "$IMAGE" ]] || [[ "$IMAGE" =~ ^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$ ]] || fail 'Invalid --image'
  [[ -z "$TEST_NAME" ]] || [[ "$TEST_NAME" =~ ^[a-z0-9][a-z0-9_.-]{0,79}$ ]] || fail 'Invalid --name'
  [[ -z "$HEALTH_TIMEOUT" ]] || [[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]{0,4}$ ]] || fail 'Invalid --health-timeout'
  for value in "$GATEWAY_HOST" "$VSCODE_SSH_HOST"; do
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail 'Gateway and VS Code SSH values must not contain line breaks'
  done
  [[ -z "$GATEWAY_HOST" ]] || [[ "$GATEWAY_HOST" =~ ^[]0-9A-Za-z.:_[-]{1,253}$ ]] || fail 'Invalid --gateway-host'
  valid_gateway_ports "$GATEWAY_PORTS" || fail 'Invalid --gateway-ports'
  if [[ -n "$TAILSCALE_SOCKET" ]]; then
    [[ "$(uname -s)" == Linux ]] || fail 'Tailscale service origins require a Linux Docker host'
    [[ "$GATEWAY" == 0 && -z "$GATEWAY_HOST" ]] || fail 'Do not combine Tailscale origins with --gateway or --gateway-host'
    [[ "${BIND_ADDRESS:-127.0.0.1}" == 127.0.0.1 ]] || fail 'Tailscale mode keeps all listeners on loopback'
    [[ "$ORIGIN" =~ ^https://[a-z0-9.-]+\.ts\.net(:[0-9]{1,5})?$ ]] ||
      fail 'Tailscale mode requires --origin https://node.tailnet.ts.net'
    TAILSCALE_PORTS="${TAILSCALE_PORTS:-8400-8499}"
    TAILSCALE_GATEWAY_PORT="${TAILSCALE_GATEWAY_PORT:-3003}"
    [[ "$TAILSCALE_PORTS" =~ ^([1-9][0-9]{0,4})-([1-9][0-9]{0,4})$ ]] || fail 'Invalid --tailscale-ports'
    first=${BASH_REMATCH[1]} last=${BASH_REMATCH[2]}
    (( first <= last && last <= 65535 && last-first <= 255 )) || fail 'Invalid Tailscale range (max 256 ports)'
    [[ "$TAILSCALE_GATEWAY_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || fail 'Invalid --tailscale-gateway-port'
    (( TAILSCALE_GATEWAY_PORT <= 65535 && TAILSCALE_GATEWAY_PORT != PORT )) || fail 'Gateway port must differ from --port'
    external=443
    [[ "$ORIGIN" =~ :([0-9]+)$ ]] && external=$((10#${BASH_REMATCH[1]}))
    for value in "$PORT" "$TAILSCALE_GATEWAY_PORT" "$external"; do
      (( value < first || value > last )) || fail 'Tailscale port range overlaps a dashboard or gateway listener'
    done
  else
    [[ -z "$TAILSCALE_PORTS" && -z "$TAILSCALE_GATEWAY_PORT" ]] || fail 'Tailscale port flags require --tailscale-socket'
  fi
}

# Verify the daemon and Linux networking contract before pulling or building.
check_daemon() {
  docker info >/dev/null 2>&1 || fail 'Cannot access the Docker daemon; check --socket'
  if [[ -n "$TAILSCALE_SOCKET" ]]; then
    [[ "$(docker info --format '{{.OSType}}')" == linux ]] || fail 'Tailscale mode requires a native Linux Docker daemon'
    echo 'Tailscale mode uses host networking and grants broad host tailscaled control.'
  fi
}

# Prepare registry mode without inspecting or replacing any running container.
prepare_registry() { check_daemon; }

# Resolve source provenance and refuse an existing test container name.
prepare_checkout() {
  local script_dir
  [[ -n "${BASH_SOURCE[0]:-}" ]] || fail 'Build mode must run from a checkout file'
  script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
  REPO_ROOT=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) || fail 'Build mode requires a git checkout'
  cd -- "$REPO_ROOT"
  [[ -f Dockerfile ]] || fail "No Dockerfile at checkout root: $REPO_ROOT"
  REVISION=$(git rev-parse HEAD)
  BRANCH=$(git symbolic-ref --quiet --short HEAD || printf 'detached HEAD')
  DIRTY=false
  [[ -z "$(git status --porcelain --untracked-files=normal)" ]] || DIRTY=true
  HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
  TEST_NAME="${TEST_NAME:-ddash-local-${REVISION:0:12}-$(date +%s)-$$}"
  IMAGE="devcontainer-dashboard:$TEST_NAME"
  check_daemon
  docker buildx version >/dev/null || fail 'Docker Buildx is required'
  if docker container inspect "$TEST_NAME" >/dev/null 2>&1; then fail "Container already exists: $TEST_NAME"; fi
}

# Preserve argv boundaries and never put the password value in Docker's argument list.
prepare_arguments() {
  local path
  if [[ "$CREATE_WORKSPACE" == 1 ]]; then mkdir -p -- "$WORKSPACE"; fi
  ARGS=()
  for path in "${ENV_FILES[@]}"; do ARGS+=(--env-file "$path"); done
  # Docker applies explicit --env entries after env files, preserving launcher inputs.
  ARGS+=(--env DASHBOARD_PASSWORD --env HOST_USER --env HOST_UID --env HOST_GID --env HOST_HOME
    --env "WORKSPACE_ROOT=$WORKSPACE" --env "HOST_HOSTNAME=${HOSTNAME:-}"
    --mount "type=bind,source=$WORKSPACE,target=$WORKSPACE"
    --mount "type=bind,source=$SOCKET,target=/var/run/docker.sock")
  [[ -z "$ORIGIN" ]] || ARGS+=(--env "ORIGIN=$ORIGIN")
  if [[ "$GATEWAY" == 1 ]]; then ARGS+=(--env "SERVICE_PROXY_ENABLED=1"); fi
  [[ -z "$GATEWAY_HOST" ]] || ARGS+=(--env "SERVICE_PROXY_HOST=$GATEWAY_HOST")
  [[ -z "$GATEWAY_PORTS" ]] || ARGS+=(--env "SERVICE_PROXY_PORTS=$GATEWAY_PORTS")
  [[ -z "$VSCODE_SSH_HOST" ]] || ARGS+=(--env "VSCODE_SSH_HOST=$VSCODE_SSH_HOST")
  if [[ -n "$TAILSCALE_SOCKET" ]]; then
    ARGS+=(--network host --env "PORT=$PORT" --env SERVICE_PROXY_ENABLED=1
      --env TAILSCALE_SOCKET=/var/run/tailscale/tailscaled.sock
      --env "TAILSCALE_SERVE_PORTS=$TAILSCALE_PORTS"
      --env "TAILSCALE_GATEWAY_PORT=$TAILSCALE_GATEWAY_PORT"
      --mount "type=bind,source=$TAILSCALE_SOCKET,target=/var/run/tailscale/tailscaled.sock")
    PUBLICATION=()
  elif [[ "$MODE" == build ]]; then PUBLICATION=(--publish "127.0.0.1:$PORT:3000")
  else PUBLICATION=(--publish "$BIND_ADDRESS:$PORT:3000")
  fi
  if [[ -n "${SSH_AUTH_SOCK:-}" ]]; then
    export SSH_AUTH_SOCK
    ARGS+=(--env SSH_AUTH_SOCK --mount "type=bind,source=$SSH_AUTH_SOCK,target=$SSH_AUTH_SOCK,readonly")
  fi
  if [[ "$SSH_DIR" == 1 ]]; then ARGS+=(--mount "type=bind,source=$HOST_HOME/.ssh,target=$HOST_HOME/.ssh,readonly"); fi
  HOOK=()
  if [[ "$BOOTSTRAP" == 1 ]]; then HOOK=(dev-bootstrap); fi
  if [[ "$MODE" == build ]]; then
    BUILD_ARGS=(--load --progress=plain --tag "$IMAGE"
      --label "org.opencontainers.image.revision=$REVISION"
      --label "devcontainer-dashboard.local-changes=$DIRTY")
    if [[ -n "$PLATFORM" ]]; then BUILD_ARGS+=(--platform "$PLATFORM"); ARGS+=(--platform "$PLATFORM"); fi
  fi
}

# Print provenance and trust boundaries, never secrets.
print_plan() {
  if [[ "$MODE" == build ]]; then printf 'Source: %s at %s (local changes: %s)\n' "$BRANCH" "$REVISION" "$DIRTY"; fi
  printf 'Operator: %s (%s:%s), home %s\n' "$HOST_USER" "$HOST_UID" "$HOST_GID" "$HOST_HOME"
  printf 'dev-bootstrap: %s (1=enabled, 0=disabled)\n' "$BOOTSTRAP"
  echo 'All bind sources must exist on the Docker host. SSH resources are read-only.'
}

# Pull and run attached; keep data/history volumes after Ctrl+C.
run_registry() {
  docker pull "$IMAGE"
  printf 'Dashboard address: http://%s:%s\n' "$BIND_ADDRESS" "$PORT"
  echo 'Ctrl+C stops the container; the dashboard_data and ddash_zsh_data volumes persist.'
  exec docker run --rm "${ARGS[@]}" "${PUBLICATION[@]}" \
    --volume dashboard_data:/data --volume ddash_zsh_data:/dashboard-history \
    --name devcontainer-dashboard "$IMAGE" "${HOOK[@]}"
}

# Build a disposable instance and retain its resources on success or failure.
run_build() {
  printf 'Test container name: %s\nImage: %s\n' "$TEST_NAME" "$IMAGE"
  docker buildx build "${BUILD_ARGS[@]}" .
  docker run --detach "${ARGS[@]}" "${PUBLICATION[@]}" \
    --volume "$TEST_NAME-data:/data" --volume "$TEST_NAME-zsh:/dashboard-history" \
    --name "$TEST_NAME" "$IMAGE" "${HOOK[@]}" || fail 'Container creation failed; check daemon-host paths and port availability'
  printf 'Retained volumes: %s-data %s-zsh\n' "$TEST_NAME" "$TEST_NAME"
  printf 'Logs: docker logs -f %s\nStop: docker stop %s\nResume: docker start %s\n' "$TEST_NAME" "$TEST_NAME" "$TEST_NAME"
  wait_for_readiness
}

# Verify the actual server port inside either bridge or host-network mode.
verify_http() {
  docker exec "$TEST_NAME" node -e '
    const http = require("node:http");
    const check = (path, expected) => new Promise((resolve, reject) => {
      const r = http.get({host:"127.0.0.1",port:Number(process.env.PORT||3000),path}, s => {
        s.resume(); s.statusCode === expected ? resolve() : reject(new Error(path+": "+s.statusCode));
      });
      r.setTimeout(3000, () => r.destroy(new Error("HTTP timeout")));
      r.on("error", reject);
    });
    Promise.all([check("/healthz",200),check("/api/containers",401)])
      .catch(e => { console.error(e.message); process.exitCode = 1; });
  '
}

# Check health until a monotonic Bash elapsed-time deadline.
wait_for_readiness() {
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

# Run phases in order and stop at the first failed precondition.
main() {
  parse_arguments "$@"
  if [[ "$SHOW_HELP" == 1 ]]; then usage; return; fi
  validate_env_files
  resolve_identity
  read_secrets
  validate_options
  if [[ "$MODE" == build ]]; then prepare_checkout; else prepare_registry; fi
  prepare_arguments
  print_plan
  if [[ "$MODE" == build ]]; then run_build; else run_registry; fi
}
main "$@"
