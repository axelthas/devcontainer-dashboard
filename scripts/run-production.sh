#!/bin/bash
# Build and validate a separate production dashboard instance from this checkout.
#
# Usage: bash scripts/run-production.sh [--workspace PATH] [--socket PATH]
#        [--port NUMBER] [--platform VALUE] [--help]
# Requires Bash, Git, Docker Buildx and daemon access. No host npm is needed.
# Reads HOST_* identity, DASHBOARD_PASSWORD and DDASH_* deployment options.
# Builds and loads an image, mounts host resources, then checks health and HTTP.
# Existing containers are not replaced. Test containers and named volumes remain
# on failure and success for inspection. SSH resources are optional and read-only.
# See scripts/README.md for defaults, unattended use and the host-path contract.

set -euo pipefail

# Print an actionable error to stderr and exit unsuccessfully. All callers stop the script.
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Identical in standalone launchers: curl | bash needs no companion file.
# Resolve the intended operator from explicit HOST_* values or passwd (SUDO_USER under sudo).
# Reject partial/invalid identities and export the complete contract for Docker/Compose.
resolve_identity() {
  local operator="${SUDO_USER:-$(id -un)}" record number
  if [[ -z "${HOST_USER:-}${HOST_UID:-}${HOST_GID:-}${HOST_HOME:-}" ]]; then
    record=$(getent passwd "$operator") || fail "Cannot resolve operator; set all four HOST_* identity values"
    IFS=: read -r HOST_USER _ HOST_UID HOST_GID _ HOST_HOME _ <<< "$record"
  fi
  [[ -n "${HOST_USER:-}" && -n "${HOST_UID:-}" && -n "${HOST_GID:-}" && -n "${HOST_HOME:-}" ]] || fail "Set all four HOST_* identity values"
  [[ "$HOST_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ && "$HOST_USER" != root ]] || fail "Invalid HOST_USER"
  for number in "$HOST_UID" "$HOST_GID"; do
    [[ "$number" =~ ^[1-9][0-9]*$ && ${#number} -le 10 ]] || fail "HOST_UID and HOST_GID must be positive non-root IDs"
    (( number <= 2147483647 )) || fail "Identity IDs are out of range"
  done
  [[ "$HOST_HOME" =~ ^/[a-zA-Z0-9_./\ -]+$ ]] || fail "Invalid absolute HOST_HOME"
  case "$HOST_HOME/" in
    /|//|*/../*|*/./*|*//*|/app/*|/data/*|/dashboard-history/*|/opt/*|/etc/*|/usr/*|/var/*|/root/*|/bin/*|/sbin/*|/dev/*|/proc/*|/sys/*|/run/*|/tmp/*)
      fail "HOST_HOME must be a canonical dedicated non-system home path" ;;
  esac
  export HOST_USER HOST_UID HOST_GID HOST_HOME
}

# Print command syntax, deployment switches and resource-retention behavior without using Docker.
usage() {
  cat <<'HELP'
Usage: bash scripts/run-production.sh [--workspace PATH] [--socket PATH]
       [--port NUMBER] [--platform VALUE] [--help]
Builds the current working tree and starts a new loopback-only test instance.
Set all four HOST_USER/HOST_UID/HOST_GID/HOST_HOME values to override identity.
DDASH_DEV_BOOTSTRAP=1 enables installation (default: 0).
DDASH_SSH_DIRECTORY=1 mounts HOST_HOME/.ssh read-only (default: 0).
An exported SSH_AUTH_SOCK is forwarded at its original Docker-host path.
DDASH_NONINTERACTIVE=1 requires a supplied DASHBOARD_PASSWORD.
DDASH_CREATE_WORKSPACE=0 avoids local workspace creation for remote daemons.
Optional: ORIGIN or DDASH_ORIGIN, DASHBOARD_TEST_NAME, DASHBOARD_HEALTH_TIMEOUT.
Existing containers and volumes remain. Nothing is published or replaced.
HELP
}

# Load environment defaults into the option variables. CLI parsing can override them next.
initialize_options() {
  WORKSPACE_ROOT="${WORKSPACE_ROOT:-}"
  DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
  HOST_PORT="${DASHBOARD_TEST_PORT:-3001}"
  PLATFORM="${DOCKER_DEFAULT_PLATFORM:-}"
  HEALTH_TIMEOUT="${DASHBOARD_HEALTH_TIMEOUT:-180}"
  ORIGIN="${ORIGIN:-${DDASH_ORIGIN:-}}"
}

# Parse option/value pairs into configuration; set SHOW_HELP to bypass all deployment work.
parse_arguments() {
  SHOW_HELP=0
  while (( $# )); do
    case "$1" in
      --help|-h) SHOW_HELP=1; return ;;
      --workspace|--socket|--port|--platform)
        [[ $# -ge 2 && -n "$2" ]] || fail "$1 requires a value"
        case "$1" in
          --workspace) WORKSPACE_ROOT="$2" ;;
          --socket) DOCKER_SOCKET="$2" ;;
          --port) HOST_PORT="$2" ;;
          --platform) PLATFORM="$2" ;;
        esac
        shift 2 ;;
      *) fail "Unknown option: $1 (use --help)" ;;
    esac
  done
}

# Validate identity-independent paths, switches, port and timeout before creating resources.
validate_options() {
  local value
  WORKSPACE_ROOT="${WORKSPACE_ROOT:-$HOST_HOME/ddash-production-workspace}"
  for value in "$WORKSPACE_ROOT" "$DOCKER_SOCKET" "${SSH_AUTH_SOCK:-/unused}"; do
    [[ "$value" == /* && "$value" != *,* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "Bind sources must be absolute Docker-host paths without commas or newlines"
  done
  for value in "${DDASH_DEV_BOOTSTRAP:-0}" "${DDASH_SSH_DIRECTORY:-0}" "${DDASH_NONINTERACTIVE:-0}" "${DDASH_CREATE_WORKSPACE:-1}"; do
    [[ "$value" == 0 || "$value" == 1 ]] || fail "DDASH_* switches must be 0 or 1"
  done
  [[ "$HOST_PORT" =~ ^[0-9]{1,5}$ ]] || fail "--port must be from 1 to 65535"
  HOST_PORT=$((10#$HOST_PORT))
  (( HOST_PORT >= 1 && HOST_PORT <= 65535 )) || fail "--port must be from 1 to 65535"
  [[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]{0,4}$ ]] || fail "Invalid DASHBOARD_HEALTH_TIMEOUT"
}

# Resolve the checkout/revision and unique test image/container name, then check daemon prerequisites.
# Reject an existing target name rather than replacing or stopping it.
prepare_checkout() {
  local script_dir
  script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
  cd "$(git -C "$script_dir" rev-parse --show-toplevel)"
  [[ -f Dockerfile ]] || fail "No Dockerfile at checkout root"
  REVISION=$(git rev-parse HEAD)
  BRANCH=$(git symbolic-ref --quiet --short HEAD || printf 'detached HEAD')
  DIRTY=false
  [[ -z "$(git status --porcelain --untracked-files=normal)" ]] || DIRTY=true
  NAME="${DASHBOARD_TEST_NAME:-ddash-local-${REVISION:0:12}-$(date +%s)-$$}"
  [[ "$NAME" =~ ^[a-z0-9][a-z0-9_.-]{0,79}$ ]] || fail "Invalid DASHBOARD_TEST_NAME"
  IMAGE="devcontainer-dashboard:$NAME"
  docker info >/dev/null || fail "Cannot access Docker daemon"
  docker buildx version >/dev/null || fail "Docker Buildx is required"
  if docker container inspect "$NAME" >/dev/null 2>&1; then fail "Container already exists: $NAME"; fi
}

# Obtain the password and export runtime values; prepare build/run argv and optional SSH/hook mounts.
# Only create the local workspace when DDASH_CREATE_WORKSPACE permits it.
prepare_runtime() {
  if [[ -z "${DASHBOARD_PASSWORD:-}" ]]; then
    [[ "${DDASH_NONINTERACTIVE:-0}" != 1 && -t 0 ]] || fail "Set a non-empty DASHBOARD_PASSWORD for non-interactive use"
    read -r -s -p 'Test dashboard password: ' DASHBOARD_PASSWORD
    printf '\n'
  fi
  [[ -n "$DASHBOARD_PASSWORD" ]] || fail "DASHBOARD_PASSWORD must not be empty"
  export DASHBOARD_PASSWORD WORKSPACE_ROOT ORIGIN
  [[ "${DDASH_CREATE_WORKSPACE:-1}" == 0 ]] || mkdir -p -- "$WORKSPACE_ROOT"
  RUN_ARGS=(--env HOST_USER --env HOST_UID --env HOST_GID --env HOST_HOME)
  BUILD_ARGS=(--load --progress=plain --tag "$IMAGE"
    --label "org.opencontainers.image.revision=$REVISION"
    --label "devcontainer-dashboard.local-changes=$DIRTY")
  if [[ -n "$PLATFORM" ]]; then
    BUILD_ARGS+=(--platform "$PLATFORM")
    RUN_ARGS+=(--platform "$PLATFORM")
  fi
  if [[ -n "${SSH_AUTH_SOCK:-}" ]]; then
    export SSH_AUTH_SOCK
    RUN_ARGS+=(--env SSH_AUTH_SOCK --mount "type=bind,source=$SSH_AUTH_SOCK,target=$SSH_AUTH_SOCK,readonly")
  fi
  if [[ "${DDASH_SSH_DIRECTORY:-0}" == 1 ]]; then
    RUN_ARGS+=(--mount "type=bind,source=$HOST_HOME/.ssh,target=$HOST_HOME/.ssh,readonly")
  fi
  HOOK=()
  [[ "${DDASH_DEV_BOOTSTRAP:-0}" != 1 ]] || HOOK=(dev-bootstrap)
}

# Print the reviewed source, operator and bootstrap mode without printing credentials.
print_plan() {
  printf 'Source: %s at %s (local changes: %s)\n' "$BRANCH" "$REVISION" "$DIRTY"
  printf 'Operator: %s (%s:%s), home %s\n' "$HOST_USER" "$HOST_UID" "$HOST_GID" "$HOST_HOME"
  printf 'dev-bootstrap: %s (1=enabled, 0=disabled)\n' "${DDASH_DEV_BOOTSTRAP:-0}"
  echo 'Bind sources must exist on the Docker host, not only inside the launcher.'
}

# Start a separate loopback-only container with selected mounts and named storage.
# Report daemon-host bind failures and print commands for retained-resource inspection.
start_container() {
  printf 'Test container name: %s\nImage: %s\n' "$NAME" "$IMAGE"
  docker run --detach "${RUN_ARGS[@]}" --name "$NAME" \
    --publish "127.0.0.1:$HOST_PORT:3000" \
    --env DASHBOARD_PASSWORD --env WORKSPACE_ROOT --env ORIGIN \
    --mount "type=bind,source=$DOCKER_SOCKET,target=/var/run/docker.sock" \
    --mount "type=bind,source=$WORKSPACE_ROOT,target=$WORKSPACE_ROOT" \
    --volume "$NAME-data:/data" --volume "$NAME-zsh:/dashboard-history" \
    "$IMAGE" "${HOOK[@]}" || fail "Container creation failed. Check daemon-host bind sources, socket access and port availability; --mount does not create missing sources."
  printf 'Retained volumes: %s-data %s-zsh\n' "$NAME" "$NAME"
  printf 'Logs: docker logs -f %s\nStop: docker stop %s\nResume: docker start %s\n' "$NAME" "$NAME" "$NAME"
}

# Run bounded readiness and unauthenticated-access checks inside the built container.
# Return failure if either HTTP status differs from the expected production contract.
verify_http() {
  docker exec "$NAME" node -e '
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
    state=$(docker inspect --format '{{.State.Status}}' "$NAME")
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME")
    [[ "$state" == running ]] || break
    if [[ "$health" == healthy ]]; then
      verify_http || fail "HTTP checks failed; container and volumes retained for inspection"
      printf 'Ready: http://127.0.0.1:%s\n' "$HOST_PORT"
      [[ -z "$ORIGIN" ]] || printf 'External origin: %s\n' "$ORIGIN"
      echo 'Log in and verify terminal output. Nothing was published.'
      return
    fi
    [[ "$health" != none && "$health" != unhealthy ]] || break
    sleep 2
  done
  docker logs "$NAME" >&2 || true
  docker inspect --format '{{json .State.Health}}' "$NAME" >&2 || true
  fail "Application did not become healthy; container and volumes retained for inspection"
}

# Run the script phases in order. Stop on a failed phase before later work can start.
main() {
  case "${1:-}" in --help|-h) usage; return ;; esac
  initialize_options
  parse_arguments "$@"
  if [[ "$SHOW_HELP" == 1 ]]; then usage; return; fi
  resolve_identity
  validate_options
  prepare_checkout
  prepare_runtime
  print_plan
  docker buildx build "${BUILD_ARGS[@]}" .
  start_container
  wait_for_readiness
}

main "$@"
