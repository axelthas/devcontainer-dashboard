#!/bin/bash
# Requires Docker Compose, Node 22, and npm ci on the host.
# Uses an isolated project, throwaway data, and a locally built image.
set -euo pipefail
cd "$(dirname "$0")/../.."
TEMP_DIR=$(mktemp -d)
PROJECT="ddash-smoke-$$"
export DASHBOARD_PASSWORD=production-smoke-password
export WORKSPACE_ROOT="${TEMP_DIR}/workspace"
unset DASHBOARD_BIND_ADDRESS
UNSTARTED=""
mkdir -p "$WORKSPACE_ROOT"
cleanup() {
  if [[ -n "$UNSTARTED" ]]; then docker rm -f "$UNSTARTED" >/dev/null 2>&1 || true; fi
  docker compose -p "$PROJECT" -f docker-compose.yml -f "${TEMP_DIR}/override.yml" down -v >/dev/null 2>&1 || true
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

# Render both maintained Compose paths. The installer needs a pseudo-terminal
# because its prompts deliberately read /dev/tty.
mkdir -p "${TEMP_DIR}/bin" "${TEMP_DIR}/home"
printf '#!/bin/sh\nexit 0\n' > "${TEMP_DIR}/bin/docker"
chmod +x "${TEMP_DIR}/bin/docker"
printf '%s\nn\n' "$WORKSPACE_ROOT" | \
  HOME="${TEMP_DIR}/home" PATH="${TEMP_DIR}/bin:$PATH" \
  script -q -e -c 'bash scripts/run-dashboard-compose.sh' /dev/null
GENERATED="${TEMP_DIR}/home/.config/devcontainer-dashboard/docker-compose.yml"
for compose in docker-compose.yml "$GENERATED"; do
  docker compose -f "$compose" config --format json > "${TEMP_DIR}/rendered.json"
  node --input-type=module - "${TEMP_DIR}/rendered.json" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(config.services.dashboard.ports[0].host_ip, '127.0.0.1');
assert.ok(config.services.dashboard.volumes.some(v => v.target === '/var/run/docker.sock'));
JS
  DASHBOARD_BIND_ADDRESS=0.0.0.0 docker compose -f "$compose" config --format json > "${TEMP_DIR}/remote.json"
  node --input-type=module - "${TEMP_DIR}/remote.json" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
assert.equal(JSON.parse(readFileSync(process.argv[2], 'utf8')).services.dashboard.ports[0].host_ip, '0.0.0.0');
JS
done

docker build -t "${PROJECT}:test" .
cat > "${TEMP_DIR}/override.yml" <<EOF
services:
  dashboard:
    image: ${PROJECT}:test
    restart: "no"
    ports: !override
      - "127.0.0.1::3000"
EOF
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f "${TEMP_DIR}/override.yml")
"${COMPOSE[@]}" up -d --wait --wait-timeout 180
ADDRESS=$("${COMPOSE[@]}" port dashboard 3000)
SMOKE_BASE_URL="http://${ADDRESS}" SMOKE_PASSWORD="$DASHBOARD_PASSWORD" node scripts/tests/production-smoke.mjs
CID=$("${COMPOSE[@]}" ps -q dashboard)
test "$(docker inspect -f '{{.State.Health.Status}}' "$CID")" = healthy

# Missing password and socket must fail before listening.
if docker run --rm "${PROJECT}:test" >"${TEMP_DIR}/missing-password.log" 2>&1; then
  echo "ERROR: container started without DASHBOARD_PASSWORD" >&2
  exit 1
fi
grep -q DASHBOARD_PASSWORD "${TEMP_DIR}/missing-password.log"
if docker run --rm -e DASHBOARD_PASSWORD "${PROJECT}:test" >"${TEMP_DIR}/missing-socket.log" 2>&1; then
  echo "ERROR: container started without a Docker socket" >&2
  exit 1
fi
grep -q 'missing or is not a Unix socket' "${TEMP_DIR}/missing-socket.log"

# The image probe must fail when the application has not started.
UNSTARTED=$(docker run -d --health-interval=1s --health-start-period=0s --health-retries=1 \
  --entrypoint sleep "${PROJECT}:test" 60)
for attempt in {1..30}; do
  STATUS=$(docker inspect -f '{{.State.Health.Status}}' "$UNSTARTED")
  [[ "$STATUS" == unhealthy ]] && break
  sleep 1
done
test "$STATUS" = unhealthy
echo "PASS: Compose rendering, clean image startup, healthcheck, login, terminal, and fail-closed startup"
