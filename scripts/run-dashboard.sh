#!/bin/bash
# Standalone installer, also safe for curl | bash.
set -euo pipefail
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

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
IMAGE="${DASHBOARD_IMAGE:-ghcr.io/axelthas/devcontainer-dashboard:latest}"
DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
if [[ -z "${WORKSPACE_ROOT:-}" ]]; then
  read -r -p "Workspace directory [$HOST_HOME/ddash-workspace]: " WORKSPACE_ROOT </dev/tty
  WORKSPACE_ROOT="${WORKSPACE_ROOT:-$HOST_HOME/ddash-workspace}"
fi
[[ "$WORKSPACE_ROOT" == /* && "$WORKSPACE_ROOT" != *,* ]] || fail "WORKSPACE_ROOT must be absolute, without commas"
if [[ -z "${DASHBOARD_PASSWORD:-}" ]]; then
  read -r -s -p 'Dashboard password: ' DASHBOARD_PASSWORD </dev/tty
  printf '\n' >/dev/tty
fi
[[ -n "$DASHBOARD_PASSWORD" ]] || fail "DASHBOARD_PASSWORD must not be empty"
export DASHBOARD_PASSWORD WORKSPACE_ROOT
mkdir -p "$WORKSPACE_ROOT"
ARGS=(--env DASHBOARD_PASSWORD --env HOST_USER --env HOST_UID --env HOST_GID --env HOST_HOME
  --env WORKSPACE_ROOT --env "HOST_HOSTNAME=${HOSTNAME:-}"
  --mount "type=bind,source=$WORKSPACE_ROOT,target=$WORKSPACE_ROOT"
  --mount "type=bind,source=$DOCKER_SOCKET,target=/var/run/docker.sock"
  --volume dashboard_data:/data --volume ddash_zsh_data:/dashboard-history)
if [[ -n "${SSH_AUTH_SOCK:-}" ]]; then
  [[ "$SSH_AUTH_SOCK" == /* && "$SSH_AUTH_SOCK" != *,* ]] || fail "SSH_AUTH_SOCK must be an absolute Docker-host socket path without commas"
  ARGS+=(--env SSH_AUTH_SOCK --mount "type=bind,source=$SSH_AUTH_SOCK,target=$SSH_AUTH_SOCK,readonly")
fi
if [[ "${DDASH_SSH_DIRECTORY:-0}" == 1 ]]; then
  [[ -d "$HOST_HOME/.ssh" ]] || fail "Missing host SSH directory: $HOST_HOME/.ssh"
  ARGS+=(--mount "type=bind,source=$HOST_HOME/.ssh,target=$HOST_HOME/.ssh,readonly")
fi
HOOK=()
[[ "${DDASH_DEV_BOOTSTRAP:-0}" != 1 ]] || HOOK=(dev-bootstrap)
docker pull "$IMAGE"
exec docker run --rm "${ARGS[@]}" \
  -p "${DASHBOARD_BIND_ADDRESS:-127.0.0.1}:3000:3000" \
  --name devcontainer-dashboard "$IMAGE" "${HOOK[@]}"
