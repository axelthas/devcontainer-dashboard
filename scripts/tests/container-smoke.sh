#!/bin/bash
# Exercise a disposable production image and sibling build on a local Docker host.
#
# Usage: bash scripts/tests/container-smoke.sh from an installed project checkout.
# Requires a non-root Linux operator with a /home home, Docker/Buildx-compatible
# image builds, Node 22, project dependencies and network access.
# Creates fake SSH data, unique containers/volumes and an operator-hook bootstrap
# stub. Builds the image, starts the fixture dashboard with plain docker run
# mirroring the launcher argv: dynamic loopback publication, read-only fixture
# hook and SSH binds, same-path workspace and socket binds, per-run named volumes.
# Then checks login/terminal identity and provider discovery, and builds a sibling
# through the authenticated dashboard API. Also checks ownership and fail-closed
# startup.
# The EXIT trap removes only this fixture's containers, named volumes and files;
# built images remain cached. Never run against a shared production deployment.
# This does not test real GitLab credentials or a real bootstrap installation.

set -euo pipefail

# Print an actionable error to stderr and exit unsuccessfully. All callers stop the script.
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Validate the local operator, create unique fake data/hooks and initialize fixture inputs.
# Register cleanup only for resources owned by this integration run.
prepare_fixture() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  [[ "$(id -u)" != 0 && "$HOME" == /home/* ]] || fail 'Use a non-root local Linux Docker operator with a /home home'
  TEMP_DIR=$(mktemp -d "$HOME/.ddash-smoke-XXXXXX")
  PROJECT="ddash-smoke-$$"
  export DASHBOARD_PASSWORD=production-smoke-password
  export HOST_USER="$(id -un)" HOST_UID="$(id -u)" HOST_GID="$(id -g)"
  export HOST_HOME="$TEMP_DIR/operator" WORKSPACE_ROOT="$TEMP_DIR/workspace"
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
  CID=''
  trap cleanup EXIT
}

# Remove fixture siblings by their exact unique workspace label, remove the fixture
# dashboard and its per-run volumes, and remove temporary data. Best-effort cleanup
# also handles partial build/startup failures.
cleanup() {
  local sibling
  [[ -z "$UNSTARTED" ]] || docker rm -f "$UNSTARTED" >/dev/null 2>&1 || true
  [[ -z "$CID" ]] || docker rm -f "$CID" >/dev/null 2>&1 || true
  # Exact unique fixture label, including when an API build fails before returning.
  while read -r sibling; do
    [[ -z "$sibling" ]] || docker rm -f "$sibling" >/dev/null 2>&1 || true
  done < <(docker ps -aq --filter "label=devcontainer.local_folder=$WORKSPACE_ROOT/fixture")
  docker volume rm "$PROJECT-data" "$PROJECT-zsh" >/dev/null 2>&1 || true
  rm -rf -- "$TEMP_DIR"
}

# Build the production image, then start the fixture dashboard with plain docker run
# mirroring the launcher argv: dynamic loopback publication, read-only fixture hooks
# and SSH binds, same-path workspace and socket binds, per-run named volumes.
# Record its container ID and assigned loopback address for later checks.
start_dashboard() {
  docker build -t "$PROJECT:test" .
  CID=$(docker run --detach --restart no \
    --name "$PROJECT-dashboard" \
    --publish "127.0.0.1::3000" \
    --env DASHBOARD_PASSWORD --env HOST_USER --env HOST_UID --env HOST_GID --env HOST_HOME \
    --env "WORKSPACE_ROOT=$WORKSPACE_ROOT" \
    --mount "type=bind,source=${DOCKER_SOCKET:-/var/run/docker.sock},target=/var/run/docker.sock" \
    --mount "type=bind,source=$WORKSPACE_ROOT,target=$WORKSPACE_ROOT" \
    --mount "type=bind,source=$TEMP_DIR/hooks,target=/docker-entrypoint.d,readonly" \
    --mount "type=bind,source=$HOST_HOME/.ssh,target=$HOST_HOME/.ssh,readonly" \
    --volume "$PROJECT-data:/data" --volume "$PROJECT-zsh:/dashboard-history" \
    "$PROJECT:test") || fail 'Fixture dashboard failed to start; check daemon bind sources and port access'
  [[ -n "$CID" ]] || fail 'Fixture dashboard did not return a container ID'
  ADDRESS=$(docker port "$CID" 3000)
  [[ "$ADDRESS" == 127.0.0.1:* && "$ADDRESS" != *$'\n'* ]] || fail "Unexpected publication address: $ADDRESS"
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
  # A zero start period is a Go zero-value and silently keeps the image's 60s
  # window, during which failed probes do not count; 1ms starts counting at once.
  UNSTARTED=$(docker run -d --health-interval=1s --health-start-period=1ms --health-retries=1 --entrypoint sleep "$PROJECT:test" 60)
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
  start_dashboard
  check_dashboard_build
  check_fail_closed
  echo 'PASS: identity, ownership, read-only HOME bind, dashboard build API, production terminal and fail-closed startup'
}

main "$@"