#!/bin/bash
# Build and run the current checkout's production image without publishing it.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/run-production.sh [options]

Builds the current working tree (including local changes) using the root
Dockerfile. Starts a new test container on 127.0.0.1 and waits for health.
Does not switch branches, pull source, publish images, or replace containers.

Options:
  --workspace PATH   Absolute workspace path on the Docker host
                     (default: WORKSPACE_ROOT or ~/ddash-production-workspace)
  --socket PATH      Host Docker socket (default: DOCKER_SOCKET or /var/run/docker.sock)
  --port NUMBER      Host loopback port (default: DASHBOARD_TEST_PORT or 3001)
  --platform VALUE   Build/run platform, for example linux/amd64
                     (default: DOCKER_DEFAULT_PLATFORM or builder default)
  --help             Show this help

Set DASHBOARD_PASSWORD or enter it at the hidden prompt.
Optional: DASHBOARD_TEST_NAME (unique image/container/volume prefix),
DASHBOARD_HEALTH_TIMEOUT (seconds, default 180).
Optional: export ORIGIN to the external HTTPS origin when using a reverse proxy.

Requires Bash, Git, Docker with Buildx, a local Docker daemon, and internet
access for the build. Host npm, Node, and curl are not needed.
The Docker socket grants full control of its daemon. Use a trusted dev host.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

WORKSPACE_ROOT="${WORKSPACE_ROOT:-${HOME}/ddash-production-workspace}"
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
      shift 2
      ;;
    *) fail "Unknown option: $1 (use --help)" ;;
  esac
done

[[ "$WORKSPACE_ROOT" == /* ]] || fail "--workspace must be an absolute Docker-host path"
[[ "$DOCKER_SOCKET" == /* ]] || fail "--socket must be an absolute Docker-host path"
# Docker --mount uses commas as field separators, even inside a quoted argument.
[[ "$WORKSPACE_ROOT" != *,* && "$DOCKER_SOCKET" != *,* ]] \
  || fail "Bind paths containing commas are not supported by this script"
[[ "$HOST_PORT" =~ ^[0-9]{1,5}$ ]] || fail "--port must be a number from 1 to 65535"
HOST_PORT=$((10#$HOST_PORT))
(( HOST_PORT >= 1 && HOST_PORT <= 65535 )) || fail "--port must be from 1 to 65535"
[[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]{0,4}$ ]] \
  || fail "DASHBOARD_HEALTH_TIMEOUT must be a positive integer of at most 5 digits"

for tool in git docker; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel) \
  || fail "Run this script from a Git checkout of devcontainer-dashboard"
cd "$ROOT"
[[ -f Dockerfile ]] || fail "No Dockerfile at the checkout root"
REVISION=$(git rev-parse HEAD)
BRANCH=$(git symbolic-ref --quiet --short HEAD || printf 'detached HEAD')
DIRTY=false
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then DIRTY=true; fi
NAME="${DASHBOARD_TEST_NAME:-ddash-local-${REVISION:0:12}-$(date +%s)-$$}"
[[ "$NAME" =~ ^[a-z0-9][a-z0-9_.-]{0,79}$ ]] \
  || fail "DASHBOARD_TEST_NAME must be 1-80 lowercase letters, digits, dots, underscores, or hyphens"
IMAGE="devcontainer-dashboard:${NAME}"
DATA_VOLUME="${NAME}-data"
ZSH_VOLUME="${NAME}-zsh"

docker info >/dev/null || fail "Cannot access the Docker daemon"
docker buildx version >/dev/null || fail "Docker Buildx is required"
if docker container inspect "$NAME" >/dev/null 2>&1; then
  fail "Container $NAME already exists; choose another DASHBOARD_TEST_NAME"
fi

if [[ -z "${DASHBOARD_PASSWORD:-}" ]]; then
  [[ -t 0 ]] || fail "Set a non-empty DASHBOARD_PASSWORD for non-interactive use"
  read -r -s -p 'Test dashboard password: ' DASHBOARD_PASSWORD
  printf '\n'
fi
[[ -n "$DASHBOARD_PASSWORD" ]] || fail "DASHBOARD_PASSWORD must not be empty"
export DASHBOARD_PASSWORD WORKSPACE_ROOT

printf 'Source: %s at %s (local changes: %s)\n' "$BRANCH" "$REVISION" "$DIRTY"
printf 'Building current working tree in %s\n' "$ROOT"
printf 'Workspace on Docker host: %s\n' "$WORKSPACE_ROOT"
printf '%s\n' 'Bind paths must exist on the Docker host. Inside a devcontainer, use host-shared paths.'
# Create the local workspace directory. The daemon still validates the host
# bind source; inside a devcontainer, this must be a host-shared path.
mkdir -p -- "$WORKSPACE_ROOT"
BUILD_ARGS=(--load --progress=plain --tag "$IMAGE"
  --label "org.opencontainers.image.revision=$REVISION"
  --label "devcontainer-dashboard.local-changes=$DIRTY")
RUN_ARGS=()
if [[ -n "$PLATFORM" ]]; then
  BUILD_ARGS+=(--platform "$PLATFORM")
  RUN_ARGS+=(--platform "$PLATFORM")
fi
docker buildx build "${BUILD_ARGS[@]}" .

# Print identifiers before run, including when Docker fails to start a container.
printf '\nTest container name: %s\nImage: %s\n' "$NAME" "$IMAGE"
docker run --detach "${RUN_ARGS[@]}" \
  --name "$NAME" \
  --publish "127.0.0.1:${HOST_PORT}:3000" \
  --env DASHBOARD_PASSWORD \
  --env WORKSPACE_ROOT \
  --env ORIGIN \
  --mount "type=bind,source=$DOCKER_SOCKET,target=/var/run/docker.sock" \
  --mount "type=bind,source=$WORKSPACE_ROOT,target=$WORKSPACE_ROOT" \
  --volume "${DATA_VOLUME}:/data" \
  --volume "${ZSH_VOLUME}:/home/ddash/.zsh_data" \
  "$IMAGE"

# Retain the test container and data on failure so developers can inspect them.
printf '\nContainer: %s\nImage: %s\n' "$NAME" "$IMAGE"
printf 'Logs: docker logs -f %s\nStop: docker stop %s\n' "$NAME" "$NAME"
printf 'Resume: docker start %s\n' "$NAME"
printf 'Retained test volumes: %s %s\n' "$DATA_VOLUME" "$ZSH_VOLUME"
printf 'Waiting up to %s seconds for the production image healthcheck...\n' "$HEALTH_TIMEOUT"
DEADLINE=$((SECONDS + HEALTH_TIMEOUT))
while (( SECONDS < DEADLINE )); do
  STATE=$(docker inspect --format '{{.State.Status}}' "$NAME")
  HEALTH=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME")
  if [[ "$STATE" != running ]]; then
    docker logs "$NAME" >&2 || true
    fail "Test container is $STATE; retained for inspection"
  fi
  if [[ "$HEALTH" == healthy ]]; then
    # Exercise the actual built HTTP handler, without needing host curl/Node.
    docker exec "$NAME" node -e '
      const http = require("node:http");
      function check(path, expected) {
        return new Promise((resolve, reject) => {
          const r = http.get({host:"127.0.0.1",port:3000,path}, response => {
            response.resume();
            response.statusCode === expected ? resolve() :
              reject(new Error(path + ": expected " + expected + ", got " + response.statusCode));
          });
          r.setTimeout(3000, () => r.destroy(new Error("HTTP check timed out")));
          r.on("error", reject);
        });
      }
      Promise.all([check("/healthz",200),check("/api/containers",401)])
        .catch(error => { console.error(error.message); process.exitCode = 1; });
    '
    printf '\nReady: http://127.0.0.1:%s\n' "$HOST_PORT"
    if [[ -n "${ORIGIN:-}" ]]; then
      printf 'External origin: %s (use this URL for login through your proxy)\n' "$ORIGIN"
    fi
    printf '%s\n' 'Health and unauthenticated API checks passed.'
    printf '%s\n' 'Log in with the test password. Open a terminal and run: printf "production-terminal-ok\n"'
    printf '%s\n' 'The container keeps running after this script exits. Nothing was published.'
    exit 0
  fi
  [[ "$HEALTH" != none && "$HEALTH" != unhealthy ]] || break
  sleep 2
done
docker logs "$NAME" >&2 || true
docker inspect --format '{{json .State.Health}}' "$NAME" >&2 || true
fail "Application did not become healthy; test container and data retained"
