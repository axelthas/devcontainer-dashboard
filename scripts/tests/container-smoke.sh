#!/bin/bash
# Exercise a disposable production image and sibling build on a local Docker host.
#
# Usage: bash scripts/tests/container-smoke.sh from an installed project checkout.
# Requires a non-root Linux operator with a /home home, Docker/Buildx-compatible
# image builds, Compose 2.24.4+, Node 22, project dependencies and network access.
# Creates fake SSH data, unique containers/volumes and an operator-hook bootstrap
# stub. Renders both Compose paths, starts the generated configuration, checks
# login/terminal identity and provider discovery, then builds a sibling through
# the authenticated dashboard API. Also checks ownership and fail-closed startup.
# The EXIT trap removes only this fixture's containers, named volumes and files;
# built images remain cached. Never run against a shared production deployment.
# This does not test real GitLab credentials or a real bootstrap installation.

set -euo pipefail

# Print an actionable error to stderr and exit unsuccessfully. All callers stop the script.
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Validate the local operator, create unique fake data/hooks and initialize fixture configuration.
# Register cleanup only for resources owned by this integration run.
prepare_fixture() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  [[ "$(id -u)" != 0 && "$HOME" == /home/* ]] || fail 'Use a non-root local Linux Docker operator with a /home home'
  TEMP_DIR=$(mktemp -d "$HOME/.ddash-smoke-XXXXXX")
  PROJECT="ddash-smoke-$$"
  export DASHBOARD_PASSWORD=production-smoke-password
  export HOST_USER="$(id -un)" HOST_UID="$(id -u)" HOST_GID="$(id -g)"
  export HOST_HOME="$TEMP_DIR/operator" WORKSPACE_ROOT="$TEMP_DIR/workspace"
  export DDASH_SSH_DIRECTORY=1 DDASH_DEV_BOOTSTRAP=0 DDASH_NONINTERACTIVE=1
  export DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
  unset SSH_AUTH_SOCK DASHBOARD_BIND_ADDRESS ORIGIN DDASH_ORIGIN
  mkdir -p "$HOST_HOME/.ssh" "$WORKSPACE_ROOT/fixture/.devcontainer" "$TEMP_DIR/bin"
  mkdir -p "$TEMP_DIR/hooks"
  echo fixture-only > "$HOST_HOME/.ssh/marker"
  # Stub only: real GitLab installation is covered by hook tests, not this fixture.
  cat > "$TEMP_DIR/hooks/10-fixture.sh" <<'HOOK'
#!/bin/sh
set -eu
test "$(id -u)" = "$HOST_UID" && test "$(id -g)" = "$HOST_GID"
touch "$WORKSPACE_ROOT/hook-ownership"
mkdir -p "$HOME/.devbootstrap" "$HOME/.local/bin"
printf '#!/bin/sh\nexit 0\n' > "$HOME/.local/bin/devbootstrap"
chmod +x "$HOME/.local/bin/devbootstrap"
HOOK
  chmod +x "$TEMP_DIR/hooks/10-fixture.sh"
  UNSTARTED=''
  COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f "$TEMP_DIR/override.yml")
  trap cleanup EXIT
}

# Remove fixture siblings by their exact unique workspace label, stop the isolated Compose project,
# and remove temporary data. Best-effort cleanup also handles partial build/startup failures.
cleanup() {
  local sibling
  [[ -z "$UNSTARTED" ]] || docker rm -f "$UNSTARTED" >/dev/null 2>&1 || true
  # Exact unique fixture label, including when an API build fails before returning.
  while read -r sibling; do
    [[ -z "$sibling" ]] || docker rm -f "$sibling" >/dev/null 2>&1 || true
  done < <(docker ps -aq --filter "label=devcontainer.local_folder=$WORKSPACE_ROOT/fixture")
  "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  rm -rf -- "$TEMP_DIR"
}

# Generate installer output with a mocked Docker command, then render both Compose configurations
# with real Compose. Verify publication/identity/storage before selecting generated output for startup.
check_compose_rendering() {
  local compose
  printf '#!/bin/sh\nexit 0\n' > "$TEMP_DIR/bin/docker"
  chmod +x "$TEMP_DIR/bin/docker"
  DDASH_CONFIG_DIR="$TEMP_DIR/config" PATH="$TEMP_DIR/bin:$PATH" bash scripts/run-dashboard-compose.sh
  for compose in docker-compose.yml "$TEMP_DIR/config/docker-compose.yml"; do
    docker compose -f "$compose" config --format json > "$TEMP_DIR/rendered.json"
    node --input-type=module - "$TEMP_DIR/rendered.json" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const service = JSON.parse(readFileSync(process.argv[2], 'utf8')).services.dashboard;
assert.equal(service.ports[0].host_ip, '127.0.0.1');
assert.equal(service.environment.HOST_UID, process.env.HOST_UID);
assert.equal(service.environment.HOST_HOME, process.env.HOST_HOME);
assert.ok(service.volumes.some(v => v.target === '/dashboard-history'));
JS
    DASHBOARD_BIND_ADDRESS=0.0.0.0 docker compose -f "$compose" config --format json > "$TEMP_DIR/remote.json"
    node --input-type=module - "$TEMP_DIR/remote.json" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
assert.equal(JSON.parse(readFileSync(process.argv[2], 'utf8')).services.dashboard.ports[0].host_ip, '0.0.0.0');
JS
  done
  # Run the real integration against the generated installer output, not just root Compose.
  COMPOSE=(docker compose -p "$PROJECT" -f "$TEMP_DIR/config/docker-compose.yml" -f "$TEMP_DIR/override.yml")
}

# Build the production image, add isolated ports/read-only fixture hooks and start the generated stack.
# Record its container ID and assigned loopback address for later checks.
start_dashboard() {
  docker build -t "$PROJECT:test" .
  cat > "$TEMP_DIR/override.yml" <<YAML
services:
  dashboard:
    image: $PROJECT:test
    restart: "no"
    ports: !override
      - "127.0.0.1::3000"
    volumes:
      - type: bind
        source: '$TEMP_DIR/hooks'
        target: /docker-entrypoint.d
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: '$HOST_HOME/.ssh'
        target: '$HOST_HOME/.ssh'
        read_only: true
        bind:
          create_host_path: false
YAML
  "${COMPOSE[@]}" up -d --wait --wait-timeout 180
  CID=$("${COMPOSE[@]}" ps -q dashboard)
  ADDRESS=$("${COMPOSE[@]}" port dashboard 3000)
}

# Write a HOME-based sibling fixture and run authenticated server/terminal/build integration checks.
# Verify selected remoteUser, read-only SSH resources and host file ownership without real keys.
check_dashboard_build() {
  local sibling
  cat > "$WORKSPACE_ROOT/fixture/.devcontainer/devcontainer.json" <<'JSON'
{
  "image": "alpine:3.21",
  "remoteUser": "root",
  "overrideCommand": true,
  "mounts": ["source=${localEnv:HOME}/.ssh,target=/fixture-ssh,type=bind,readonly"]
}
JSON
  SMOKE_BASE_URL="http://$ADDRESS" SMOKE_PASSWORD="$DASHBOARD_PASSWORD" \
    SMOKE_EXPECT_UID="$HOST_UID" SMOKE_EXPECT_GID="$HOST_GID" \
    SMOKE_EXPECT_BOOTSTRAP=1 \
    SMOKE_FIXTURE_CLEANUP_OWNER=external \
    SMOKE_FIXTURE_WORKSPACE="$WORKSPACE_ROOT/fixture" node scripts/tests/production-smoke.mjs
  sibling=$(docker ps -aq --filter "label=devcontainer.local_folder=$WORKSPACE_ROOT/fixture")
  [[ -n "$sibling" && "$sibling" != *$'\n'* ]] || fail 'Expected one fixture sibling'
  docker exec "$sibling" sh -c 'test "$(cat /fixture-ssh/marker)" = fixture-only; test "$(id -u)" = 0; ! touch /fixture-ssh/should-not-write'
  docker exec "$CID" runuser -u "$HOST_USER" -- sh -c 'command -v devcontainer; touch "$WORKSPACE_ROOT/ownership"'
  test "$(stat -c %u "$WORKSPACE_ROOT/ownership")" = "$HOST_UID"
  test "$(stat -c %g "$WORKSPACE_ROOT/ownership")" = "$HOST_GID"
  test "$(stat -c %u "$WORKSPACE_ROOT/hook-ownership")" = "$HOST_UID"
  test "$(stat -c %g "$WORKSPACE_ROOT/hook-ownership")" = "$HOST_GID"
  test "$(stat -c %u "$HOST_HOME/.ssh/marker")" = "$HOST_UID"
  test "$(stat -c %g "$HOST_HOME/.ssh/marker")" = "$HOST_GID"
}

# Verify missing password/socket prevent startup, then verify health stays unhealthy without a server.
check_fail_closed() {
  local attempt status
  if docker run --rm "$PROJECT:test" > "$TEMP_DIR/failure.log" 2>&1; then fail 'Missing password was accepted'; fi
  grep -q DASHBOARD_PASSWORD "$TEMP_DIR/failure.log"
  if docker run --rm -e DASHBOARD_PASSWORD -e HOST_USER -e HOST_UID -e HOST_GID -e HOST_HOME \
    "$PROJECT:test" > "$TEMP_DIR/failure.log" 2>&1; then fail 'Missing socket was accepted'; fi
  grep -q 'missing or is not a Unix socket' "$TEMP_DIR/failure.log"
  UNSTARTED=$(docker run -d --health-interval=1s --health-start-period=0s --health-retries=1 --entrypoint sleep "$PROJECT:test" 60)
  for attempt in {1..30}; do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$UNSTARTED")
    [[ "$status" != unhealthy ]] || break
    sleep 1
  done
  test "$status" = unhealthy
}

# Run the script phases in order. Stop on a failed phase before later work can start.
main() {
  prepare_fixture
  check_compose_rendering
  start_dashboard
  check_dashboard_build
  check_fail_closed
  echo 'PASS: identity, ownership, read-only HOME bind, dashboard build API, production terminal and fail-closed startup'
}

main "$@"
