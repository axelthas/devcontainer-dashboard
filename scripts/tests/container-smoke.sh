#!/bin/bash
# Requires a non-root local Linux Docker operator, Compose 2.24.4+, Node 22,
# util-linux script, npm ci, and internet access for image builds.
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ "$(id -u)" != 0 && "$HOME" == /home/* ]] || {
  echo "Run as a non-root Linux operator with a /home home." >&2; exit 1;
}
TEMP_DIR=$(mktemp -d "$HOME/.ddash-smoke-XXXXXX")
PROJECT="ddash-smoke-$$"
export DASHBOARD_PASSWORD=production-smoke-password
export HOST_USER="$(id -un)" HOST_UID="$(id -u)" HOST_GID="$(id -g)"
# A private test home, not the operator's real home or credentials.
export HOST_HOME="$TEMP_DIR/operator"
export WORKSPACE_ROOT="$TEMP_DIR/workspace"
export DDASH_SSH_DIRECTORY=1 DDASH_DEV_BOOTSTRAP=0
export DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
unset SSH_AUTH_SOCK DASHBOARD_BIND_ADDRESS
mkdir -p "$HOST_HOME/.ssh" "$WORKSPACE_ROOT/fixture/.devcontainer" "$TEMP_DIR/bin"
echo fixture-only > "$HOST_HOME/.ssh/marker"
UNSTARTED="" SIBLING=""
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f "$TEMP_DIR/override.yml")
cleanup() {
  [[ -z "$UNSTARTED" ]] || docker rm -f "$UNSTARTED" >/dev/null 2>&1 || true
  [[ -z "$SIBLING" ]] || docker rm -f "$SIBLING" >/dev/null 2>&1 || true
  "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

# Render the generated Compose path with no real credentials.
printf '#!/bin/sh\nexit 0\n' > "$TEMP_DIR/bin/docker"
chmod +x "$TEMP_DIR/bin/docker"
printf '\n' | DDASH_ORIGIN="" DDASH_CONFIG_DIR="$TEMP_DIR/config" \
  PATH="$TEMP_DIR/bin:$PATH" script -q -e -c 'bash scripts/run-dashboard-compose.sh' /dev/null
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
done

docker build -t "$PROJECT:test" .
cat > "$TEMP_DIR/override.yml" <<EOF
services:
  dashboard:
    image: $PROJECT:test
    restart: "no"
    ports: !override
      - "127.0.0.1::3000"
    volumes:
      - type: bind
        source: $HOST_HOME/.ssh
        target: $HOST_HOME/.ssh
        read_only: true
        bind:
          create_host_path: false
EOF
"${COMPOSE[@]}" up -d --wait --wait-timeout 180
CID=$("${COMPOSE[@]}" ps -q dashboard)
ADDRESS=$("${COMPOSE[@]}" port dashboard 3000)
SMOKE_BASE_URL="http://$ADDRESS" SMOKE_PASSWORD="$DASHBOARD_PASSWORD" node scripts/tests/production-smoke.mjs
docker exec "$CID" runuser -u "$HOST_USER" -- sh -c '
  test "$(id -u)" = "$HOST_UID" && test "$(id -g)" = "$HOST_GID"
  test "$HOME" = "$HOST_HOME" && test "$USER" = "$HOST_USER"
  command -v devcontainer
  touch "$WORKSPACE_ROOT/ownership"
'
test "$(stat -c %u "$WORKSPACE_ROOT/ownership")" = "$HOST_UID"
test "$(stat -c %g "$WORKSPACE_ROOT/ownership")" = "$HOST_GID"

# HOME-based localEnv bind sources must resolve on the daemon host.
cat > "$WORKSPACE_ROOT/fixture/.devcontainer/devcontainer.json" <<'EOF'
{
  "image": "alpine:3.21",
  "remoteUser": "root",
  "overrideCommand": true,
  "mounts": ["source=${localEnv:HOME}/.ssh,target=/fixture-ssh,type=bind,readonly"]
}
EOF
docker exec "$CID" runuser -u "$HOST_USER" -- devcontainer up \
  --workspace-folder "$WORKSPACE_ROOT/fixture"
SIBLING=$(docker ps -aq --filter "label=devcontainer.local_folder=$WORKSPACE_ROOT/fixture")
[[ -n "$SIBLING" ]] || { echo "No sibling devcontainer created" >&2; exit 1; }
docker exec "$SIBLING" sh -c 'test "$(cat /fixture-ssh/marker)" = fixture-only; test "$(id -u)" = 0'

if docker run --rm "$PROJECT:test" > "$TEMP_DIR/failure.log" 2>&1; then exit 1; fi
grep -q DASHBOARD_PASSWORD "$TEMP_DIR/failure.log"
if docker run --rm -e DASHBOARD_PASSWORD -e HOST_USER -e HOST_UID -e HOST_GID -e HOST_HOME \
  "$PROJECT:test" > "$TEMP_DIR/failure.log" 2>&1; then exit 1; fi
grep -q 'missing or is not a Unix socket' "$TEMP_DIR/failure.log"
UNSTARTED=$(docker run -d --health-interval=1s --health-start-period=0s --health-retries=1 \
  --entrypoint sleep "$PROJECT:test" 60)
for attempt in {1..30}; do
  STATUS=$(docker inspect -f '{{.State.Health.Status}}' "$UNSTARTED")
  [[ "$STATUS" == unhealthy ]] && break
  sleep 1
done
test "$STATUS" = unhealthy
echo "PASS: identity, file ownership, sibling HOME bind, production login/terminal and fail-closed startup"
