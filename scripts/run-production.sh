#!/bin/bash
# Build and run the current checkout, without publication or replacement.
set -euo pipefail
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Builds the current working tree and starts a separate production container.
Usage: bash scripts/run-production.sh [--workspace PATH] [--socket PATH]
       [--port NUMBER] [--platform VALUE] [--help]
Set HOST_USER, HOST_UID, HOST_GID, HOST_HOME for an explicit Docker-host identity.
Otherwise use the local account (SUDO_USER when invoked with sudo).
Optional SSH_AUTH_SOCK is mounted at its original host path.
Set DDASH_SSH_DIRECTORY=1 for a read-only HOST_HOME/.ssh mount.
Set DDASH_DEV_BOOTSTRAP=1 to run the bundled hook (off by default).
Set DASHBOARD_PASSWORD or enter it at the hidden prompt.
Optional ORIGIN, DASHBOARD_TEST_NAME, DASHBOARD_HEALTH_TIMEOUT (default 180).
Requires Bash, Git, Docker Buildx and internet access, not host npm/Node.
See HOST-IDENTITY.md for storage migration and the complete identity contract.
EOF
}
WORKSPACE_ROOT="${WORKSPACE_ROOT:-}"
DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
HOST_PORT="${DASHBOARD_TEST_PORT:-3001}"
PLATFORM="${DOCKER_DEFAULT_PLATFORM:-}"
HEALTH_TIMEOUT="${DASHBOARD_HEALTH_TIMEOUT:-180}"
ORIGIN="${ORIGIN:-${DDASH_ORIGIN:-}}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --workspace|--socket|--port|--platform)
      [[ $# -ge 2 && -n "$2" ]] || fail "$1 requires a value"
      case "$1" in
        --workspace) WORKSPACE_ROOT="$2" ;;
        --socket) DOCKER_SOCKET="$2" ;;
        --port) HOST_PORT="$2" ;;
        --platform) PLATFORM="$2" ;;
      esac
      shift 2 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

# Keep this block identical in all three standalone launchers.
resolve_identity() {
  local operator="${SUDO_USER:-$(id -un)}" record
  if [[ -z "${HOST_USER:-}${HOST_UID:-}${HOST_GID:-}${HOST_HOME:-}" ]]; then
    record=$(getent passwd "$operator") || fail "Cannot resolve operator; set all four HOST_* identity values"
    HOST_USER="$operator"
    HOST_UID=$(printf '%s' "$record" | cut -d: -f3)
    HOST_GID=$(printf '%s' "$record" | cut -d: -f4)
    HOST_HOME=$(printf '%s' "$record" | cut -d: -f6)
  fi
  [[ -n "${HOST_USER:-}" && -n "${HOST_UID:-}" && -n "${HOST_GID:-}" && -n "${HOST_HOME:-}" ]] || fail "Set all four HOST_* identity values"
  [[ "$HOST_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ && "$HOST_USER" != root ]] || fail "Invalid HOST_USER"
  [[ "$HOST_UID" =~ ^[1-9][0-9]*$ && "$HOST_GID" =~ ^[1-9][0-9]*$ ]] || fail "HOST_UID and HOST_GID must be positive non-root IDs"
  [[ "$HOST_HOME" =~ ^/[a-zA-Z0-9_./\ -]+$ && "$HOST_HOME" != *"/../"* && "$HOST_HOME" != */ ]] || fail "Invalid absolute HOST_HOME"
  export HOST_USER HOST_UID HOST_GID HOST_HOME
}
resolve_identity
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$HOST_HOME/ddash-production-workspace}"
[[ "$WORKSPACE_ROOT" == /* && "$DOCKER_SOCKET" == /* ]] || fail "Workspace and socket must be absolute Docker-host paths"
[[ "$WORKSPACE_ROOT" != *,* && "$DOCKER_SOCKET" != *,* ]] || fail "Bind paths containing commas are not supported"
[[ "$HOST_PORT" =~ ^[0-9]{1,5}$ ]] || fail "--port must be from 1 to 65535"
HOST_PORT=$((10#$HOST_PORT))
(( HOST_PORT >= 1 && HOST_PORT <= 65535 )) || fail "--port must be from 1 to 65535"
[[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]{0,4}$ ]] || fail "Invalid DASHBOARD_HEALTH_TIMEOUT"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
cd "$ROOT"
[[ -f Dockerfile ]] || fail "No Dockerfile at checkout root"
REVISION=$(git rev-parse HEAD)
BRANCH=$(git symbolic-ref --quiet --short HEAD || printf 'detached HEAD')
DIRTY=false
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || DIRTY=true
NAME="${DASHBOARD_TEST_NAME:-ddash-local-${REVISION:0:12}-$(date +%s)-$$}"
[[ "$NAME" =~ ^[a-z0-9][a-z0-9_.-]{0,79}$ ]] || fail "Invalid DASHBOARD_TEST_NAME"
IMAGE="devcontainer-dashboard:$NAME"
DATA_VOLUME="$NAME-data"
ZSH_VOLUME="$NAME-zsh"
docker info >/dev/null || fail "Cannot access Docker daemon"
docker buildx version >/dev/null || fail "Docker Buildx is required"
if docker container inspect "$NAME" >/dev/null 2>&1; then fail "Container already exists: $NAME"; fi
if [[ -z "${DASHBOARD_PASSWORD:-}" ]]; then
  [[ -t 0 ]] || fail "Set a non-empty DASHBOARD_PASSWORD for non-interactive use"
  read -r -s -p 'Test dashboard password: ' DASHBOARD_PASSWORD
  printf '\n'
fi
[[ -n "$DASHBOARD_PASSWORD" ]] || fail "DASHBOARD_PASSWORD must not be empty"
export DASHBOARD_PASSWORD WORKSPACE_ROOT ORIGIN
printf 'Source: %s at %s (local changes: %s)\n' "$BRANCH" "$REVISION" "$DIRTY"
printf 'Operator: %s (%s:%s), home %s\n' "$HOST_USER" "$HOST_UID" "$HOST_GID" "$HOST_HOME"
echo "Bind sources must exist on the Docker host, not only inside a launching devcontainer."
mkdir -p "$WORKSPACE_ROOT"
BUILD_ARGS=(--load --progress=plain --tag "$IMAGE"
  --label "org.opencontainers.image.revision=$REVISION"
  --label "devcontainer-dashboard.local-changes=$DIRTY")
RUN_ARGS=(--env HOST_USER --env HOST_UID --env HOST_GID --env HOST_HOME)
if [[ -n "$PLATFORM" ]]; then
  BUILD_ARGS+=(--platform "$PLATFORM")
  RUN_ARGS+=(--platform "$PLATFORM")
fi
if [[ -n "${SSH_AUTH_SOCK:-}" ]]; then
  [[ "$SSH_AUTH_SOCK" == /* && "$SSH_AUTH_SOCK" != *,* ]] || fail "Invalid absolute SSH_AUTH_SOCK"
  RUN_ARGS+=(--env SSH_AUTH_SOCK --mount "type=bind,source=$SSH_AUTH_SOCK,target=$SSH_AUTH_SOCK,readonly")
fi
if [[ "${DDASH_SSH_DIRECTORY:-0}" == 1 ]]; then
  [[ -d "$HOST_HOME/.ssh" ]] || fail "Missing host SSH directory: $HOST_HOME/.ssh"
  RUN_ARGS+=(--mount "type=bind,source=$HOST_HOME/.ssh,target=$HOST_HOME/.ssh,readonly")
fi
HOOK=()
[[ "${DDASH_DEV_BOOTSTRAP:-0}" != 1 ]] || HOOK=(dev-bootstrap)
docker buildx build "${BUILD_ARGS[@]}" .
printf 'Test container name: %s\nImage: %s\n' "$NAME" "$IMAGE"
docker run --detach "${RUN_ARGS[@]}" --name "$NAME" \
  --publish "127.0.0.1:$HOST_PORT:3000" \
  --env DASHBOARD_PASSWORD --env WORKSPACE_ROOT --env ORIGIN \
  --mount "type=bind,source=$DOCKER_SOCKET,target=/var/run/docker.sock" \
  --mount "type=bind,source=$WORKSPACE_ROOT,target=$WORKSPACE_ROOT" \
  --volume "$DATA_VOLUME:/data" --volume "$ZSH_VOLUME:/dashboard-history" \
  "$IMAGE" "${HOOK[@]}"
printf 'Container and volumes retained: %s %s %s\n' "$NAME" "$DATA_VOLUME" "$ZSH_VOLUME"
printf 'Logs: docker logs -f %s\nStop: docker stop %s\nResume: docker start %s\n' "$NAME" "$NAME" "$NAME"
DEADLINE=$((SECONDS + HEALTH_TIMEOUT))
while (( SECONDS < DEADLINE )); do
  STATE=$(docker inspect --format '{{.State.Status}}' "$NAME")
  HEALTH=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME")
  [[ "$STATE" == running ]] || break
  if [[ "$HEALTH" == healthy ]]; then
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
    printf 'Ready: http://127.0.0.1:%s\n' "$HOST_PORT"
    [[ -z "$ORIGIN" ]] || printf 'External origin: %s\n' "$ORIGIN"
    echo 'Log in and verify terminal output. Nothing was published.'
    exit 0
  fi
  [[ "$HEALTH" != none && "$HEALTH" != unhealthy ]] || break
  sleep 2
done
docker logs "$NAME" >&2 || true
docker inspect --format '{{json .State.Health}}' "$NAME" >&2 || true
fail "Application did not become healthy; container and data retained for inspection"
