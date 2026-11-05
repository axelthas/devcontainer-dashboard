#!/usr/bin/env bash
# Build this checkout and run a separate Linux-host-network test instance.
# This opt-in runner never changes Tailscale, stops another container, or publishes an image.
# Usage: bash scripts/run-service-origins.sh ROUTES_JSON ORIGIN WORKSPACE PASSWORD_FILE
set -euo pipefail

# Print one diagnostic and stop before creating resources.
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Validate local inputs and resolve an unprivileged operator account.
configure() {
  [[ $# == 4 ]] || fail 'Usage: run-service-origins.sh ROUTES_JSON HTTPS_ORIGIN WORKSPACE PASSWORD_FILE'
  ROUTES=$1 ORIGIN=$2 WORKSPACE=$3 PASSWORD_FILE=$4
  [[ $(uname -s) == Linux ]] || fail 'This runner requires Docker Engine on Linux, not Docker Desktop.'
  [[ -r "$ROUTES" && -r "$PASSWORD_FILE" ]] || fail 'Routes and password files must be readable.'
  [[ "$WORKSPACE" == /* && "$WORKSPACE" != *,* && -d "$WORKSPACE" ]] ||
    fail 'Workspace must be an existing absolute Docker-host path without commas.'
  [[ "$ORIGIN" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]{1,5})?$ ]] ||
    fail 'Use an exact HTTPS origin without a path or trailing slash.'
  local record operator="${SUDO_USER:-$(id -un)}"
  record=$(getent passwd "$operator") || fail 'Cannot resolve operator identity.'
  IFS=: read -r HOST_USER _ HOST_UID HOST_GID _ HOST_HOME _ <<< "$record"
  [[ "$HOST_UID" != 0 ]] || fail 'Run as the intended non-root dashboard operator.'
  export HOST_USER HOST_UID HOST_GID HOST_HOME
  SERVICE_ORIGINS=$(cat -- "$ROUTES")
  IFS= read -r -d '' DASHBOARD_PASSWORD < "$PASSWORD_FILE" || true
  DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD%$'\n'}"
  [[ -n "$DASHBOARD_PASSWORD" ]] || fail 'Password must not be empty.'
  export SERVICE_ORIGINS DASHBOARD_PASSWORD
  ROOT=$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
  NAME="ddash-origins-$(date +%s)-$$"
  IMAGE="devcontainer-dashboard:$NAME"
}

# Build and start without exposing HTTP on host interfaces or replacing existing instances.
run() {
  cd -- "$ROOT"
  printf 'Building %s at %s\n' "$(git branch --show-current)" "$(git rev-parse HEAD)"
  printf 'Local changes:\n'
  git status --short
  docker buildx build --load --tag "$IMAGE" .
  # Host networking lets the gateway reach Docker-host loopback. Both the dashboard
  # and service listeners explicitly bind loopback; do not remove those controls.
  docker run --detach --network host --name "$NAME" \
    --env HOST_USER --env HOST_UID --env HOST_GID --env HOST_HOME \
    --env DASHBOARD_PASSWORD --env SERVICE_ORIGINS \
    --env "ORIGIN=$ORIGIN" --env PORT=4300 \
    --env DASHBOARD_LISTEN_ADDRESS=127.0.0.1 \
    --env SERVICE_PROXY_ENABLED=1 --env SERVICE_PROXY_HOST=127.0.0.1 \
    --env SERVICE_PROXY_PORTS=3000:http \
    --env "WORKSPACE_ROOT=$WORKSPACE" --env "HOST_HOSTNAME=$(hostname)" \
    --mount "type=bind,source=$WORKSPACE,target=$WORKSPACE" \
    --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
    --volume "$NAME-data:/data" --volume "$NAME-history:/dashboard-history" \
    "$IMAGE"
  printf 'Container: %s\nDashboard loopback: http://127.0.0.1:4300\n' "$NAME"
  printf 'Check: docker logs -f %s\nStop: docker stop %s\n' "$NAME" "$NAME"
  printf 'Tailscale was NOT changed. Configure Serve only after checking its existing listeners.\n'
}

# Run the ordered phases; retain the container and named volumes for inspection.
main() {
  configure "$@"
  run
}

main "$@"
