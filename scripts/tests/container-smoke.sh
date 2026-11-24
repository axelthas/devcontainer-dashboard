#!/bin/bash
# Exercise a disposable production image and a non-root sibling on a native Linux Docker host.
# Requires a non-root /home operator, Docker/Buildx, Node 22, installed project
# dependencies, openssh-client and network access. Builds fixture images and starts
# only uniquely named test containers/volumes. A private fixture agent and generated
# throwaway key exercise listing and signing; no real agent or private key is mounted.
# The EXIT trap removes only this run's containers, volumes, agent and temporary data.
# Built images remain cached. Do not run against a shared production deployment.
# This does not test real GitLab authentication or a real bootstrap installation.

set -euo pipefail

# Stop immediately with an actionable fixture failure.
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Validate prerequisites and register cleanup before starting disposable resources.
prepare_fixture() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  [[ "$(id -u)" != 0 && "$HOME" == /home/* ]] || fail 'Use a non-root native Linux Docker operator with a /home home'
  local tool
  for tool in docker node ssh-agent ssh-add ssh-keygen; do
    command -v "$tool" >/dev/null || fail "Install the required fixture tool: $tool"
  done
  TEMP_DIR=$(mktemp -d "$HOME/.ddash-smoke-XXXXXX")
  PROJECT="ddash-smoke-$(basename "$TEMP_DIR" | tr '[:upper:]' '[:lower:]')"
  UNSTARTED=''
  CID=''
  FIXTURE_AGENT_PID=''
  trap cleanup EXIT
  export DASHBOARD_PASSWORD=production-smoke-password
  export HOST_USER="$(id -un)" HOST_UID="$(id -u)" HOST_GID="$(id -g)"
  export HOST_HOME="$TEMP_DIR/operator" WORKSPACE_ROOT="$TEMP_DIR/workspace"
  FIXTURE_AGENT_SOCKET="$TEMP_DIR/agent.sock"
  # Unix-domain sockets have a small pathname limit; fail before starting anything.
  [[ ${#FIXTURE_AGENT_SOCKET} -lt 100 ]] || fail 'Use a shorter host HOME for the fixture socket'
  mkdir -p "$WORKSPACE_ROOT/fixture/.devcontainer" "$TEMP_DIR/hooks"
  ssh-keygen -q -t ed25519 -N '' -C "$PROJECT" -f "$TEMP_DIR/fixture-key"
  cp "$TEMP_DIR/fixture-key.pub" "$WORKSPACE_ROOT/fixture/agent-key.pub"
  awk '{print "fixture.invalid " $1 " " $2}' "$TEMP_DIR/fixture-key.pub" > "$TEMP_DIR/known_hosts"
  ssh-agent -D -a "$FIXTURE_AGENT_SOCKET" > "$TEMP_DIR/agent.log" 2>&1 &
  FIXTURE_AGENT_PID=$!
  local attempt
  for attempt in {1..50}; do
    [[ ! -S "$FIXTURE_AGENT_SOCKET" ]] || break
    kill -0 "$FIXTURE_AGENT_PID" 2>/dev/null || fail 'Fixture agent stopped before creating its socket'
    sleep 0.1
  done
  [[ -S "$FIXTURE_AGENT_SOCKET" ]] || fail 'Fixture agent did not create its socket'
  SSH_AUTH_SOCK="$FIXTURE_AGENT_SOCKET" ssh-add "$TEMP_DIR/fixture-key" >/dev/null 2>&1
  FIXTURE_IDENTITIES=$(SSH_AUTH_SOCK="$FIXTURE_AGENT_SOCKET" ssh-add -L)
  # Stub installation only. Real installer behavior is covered separately.
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
}

# Remove only exact resources created by this fixture, including partial failures.
cleanup() {
  local sibling
  [[ -z "$UNSTARTED" ]] || docker rm -f "$UNSTARTED" >/dev/null 2>&1 || true
  [[ -z "$CID" ]] || docker rm -f "$CID" >/dev/null 2>&1 || true
  while read -r sibling; do
    [[ -z "$sibling" ]] || docker rm -f "$sibling" >/dev/null 2>&1 || true
  done < <(docker ps -aq --filter "label=devcontainer.local_folder=$WORKSPACE_ROOT/fixture")
  docker volume rm "$PROJECT-data" "$PROJECT-zsh" >/dev/null 2>&1 || true
  if [[ -n "$FIXTURE_AGENT_PID" ]]; then
    kill "$FIXTURE_AGENT_PID" 2>/dev/null || true
    wait "$FIXTURE_AGENT_PID" 2>/dev/null || true
  fi
  rm -rf -- "$TEMP_DIR"
}

# Build and start one isolated dashboard, with a fixture socket and trust file only.
start_dashboard() {
  docker build -t "$PROJECT:test" .
  CID=$(docker run --detach --restart no \
    --name "$PROJECT-dashboard" \
    --publish "127.0.0.1::3000" \
    --env DASHBOARD_PASSWORD --env HOST_USER --env HOST_UID --env HOST_GID --env HOST_HOME \
    --env "WORKSPACE_ROOT=$WORKSPACE_ROOT" \
    --env "SSH_AUTH_SOCK=$FIXTURE_AGENT_SOCKET" --env DEVHARBOUR_KNOWN_HOSTS=1 \
    --mount "type=bind,source=${DOCKER_SOCKET:-/var/run/docker.sock},target=/var/run/docker.sock" \
    --mount "type=bind,source=$WORKSPACE_ROOT,target=$WORKSPACE_ROOT" \
    --mount "type=bind,source=$TEMP_DIR/hooks,target=/docker-entrypoint.d,readonly" \
    --mount "type=bind,source=$FIXTURE_AGENT_SOCKET,target=$FIXTURE_AGENT_SOCKET,readonly" \
    --mount "type=bind,source=$TEMP_DIR/known_hosts,target=/etc/ssh/ssh_known_hosts,readonly" \
    --volume "$PROJECT-data:/data" --volume "$PROJECT-zsh:/dashboard-history" \
    "$PROJECT:test") || fail 'Fixture dashboard failed to start; check daemon paths and port access'
  [[ -n "$CID" ]] || fail 'Fixture dashboard did not return a container ID'
  ADDRESS=$(docker port "$CID" 3000)
  [[ "$ADDRESS" == 127.0.0.1:* && "$ADDRESS" != *$'\n'* ]] || fail "Unexpected publication address: $ADDRESS"
}

# Build a sibling with openssh-client and an explicit non-root, host-matching UID.
# Compare the exact public identity and request a real signature through each hop.
check_dashboard_build() {
  local sibling dashboard_identities sibling_identities
  cat > "$WORKSPACE_ROOT/fixture/.devcontainer/Dockerfile" <<'DOCKERFILE'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG OPERATOR_UID
ARG OPERATOR_GID
RUN groupadd --gid "$OPERATOR_GID" fixture \
    && useradd --create-home --uid "$OPERATOR_UID" --gid "$OPERATOR_GID" fixture
DOCKERFILE
  cat > "$WORKSPACE_ROOT/fixture/.devcontainer/devcontainer.json" <<JSON
{
  "build": {
    "dockerfile": "Dockerfile",
    "args": {"OPERATOR_UID": "$HOST_UID", "OPERATOR_GID": "$HOST_GID"}
  },
  "remoteUser": "fixture",
  "updateRemoteUserUID": false,
  "overrideCommand": true
}
JSON
  SMOKE_BASE_URL="http://$ADDRESS" SMOKE_PASSWORD="$DASHBOARD_PASSWORD" \
    SMOKE_EXPECT_UID="$HOST_UID" SMOKE_EXPECT_GID="$HOST_GID" \
    SMOKE_EXPECT_BOOTSTRAP=1 SMOKE_FIXTURE_CLEANUP_OWNER=external \
    SMOKE_FIXTURE_WORKSPACE="$WORKSPACE_ROOT/fixture" node scripts/tests/production-smoke.mjs
  sibling=$(docker ps -aq --filter "label=devcontainer.local_folder=$WORKSPACE_ROOT/fixture")
  [[ -n "$sibling" && "$sibling" != *$'\n'* ]] || fail 'Expected one fixture sibling'
  dashboard_identities=$(docker exec "$CID" runuser -u "$HOST_USER" -- ssh-add -L)
  sibling_identities=$(docker exec --user "$HOST_UID:$HOST_GID" "$sibling" ssh-add -L)
  [[ "$dashboard_identities" == "$FIXTURE_IDENTITIES" ]] || fail 'Dashboard agent identities differ'
  [[ "$sibling_identities" == "$FIXTURE_IDENTITIES" ]] || fail 'Sibling agent identities differ'
  docker exec "$CID" runuser -u "$HOST_USER" -- ssh-add -T "$WORKSPACE_ROOT/fixture/agent-key.pub"
  docker exec --user "$HOST_UID:$HOST_GID" "$sibling" ssh-add -T /workspaces/fixture/agent-key.pub
  docker exec --user "$HOST_UID:$HOST_GID" "$sibling" sh -c 'test "$(id -un)" = fixture'
  docker exec "$CID" runuser -u "$HOST_USER" -- sh -c \
    'command -v devcontainer; touch "$WORKSPACE_ROOT/ownership"; ! touch /etc/ssh/ssh_known_hosts'
  test "$(stat -c %u "$WORKSPACE_ROOT/ownership")" = "$HOST_UID"
  test "$(stat -c %g "$WORKSPACE_ROOT/ownership")" = "$HOST_GID"
  test "$(stat -c %u "$WORKSPACE_ROOT/hook-ownership")" = "$HOST_UID"
  test "$(stat -c %g "$WORKSPACE_ROOT/hook-ownership")" = "$HOST_GID"
}

# Verify fail-closed startup and a health failure without the server.
check_fail_closed() {
  local attempt status
  if docker run --rm "$PROJECT:test" > "$TEMP_DIR/failure.log" 2>&1; then fail 'Missing password was accepted'; fi
  grep -q DASHBOARD_PASSWORD "$TEMP_DIR/failure.log"
  if docker run --rm -e DASHBOARD_PASSWORD -e HOST_USER -e HOST_UID -e HOST_GID -e HOST_HOME \
    "$PROJECT:test" > "$TEMP_DIR/failure.log" 2>&1; then fail 'Missing socket was accepted'; fi
  grep -q 'missing or is not a Unix socket' "$TEMP_DIR/failure.log"
  # A nonzero start period ensures health failures count immediately.
  UNSTARTED=$(docker run -d --health-interval=1s --health-start-period=1ms --health-retries=1 --entrypoint sleep "$PROJECT:test" 60)
  for attempt in {1..30}; do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$UNSTARTED")
    [[ "$status" != unhealthy ]] || break
    sleep 1
  done
  test "$status" = unhealthy
}

# Run each fixture phase in order and preserve failure cleanup through the trap.
main() {
  prepare_fixture
  start_dashboard
  check_dashboard_build
  check_fail_closed
  echo 'PASS: operator identity, fixture-agent listing/signing across both hops, trust mount, production terminal and fail-closed startup'
}

main "$@"
