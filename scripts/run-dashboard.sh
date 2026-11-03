#!/bin/bash
# Standalone launcher. See scripts/README.md.
set -euo pipefail

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Identical in standalone launchers: curl | bash needs no companion file.
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

read_configuration() {
  IMAGE="${DASHBOARD_IMAGE:-ghcr.io/axelthas/devcontainer-dashboard:latest}"
  DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
  ORIGIN="${ORIGIN:-${DDASH_ORIGIN:-}}"
  if [[ -z "${WORKSPACE_ROOT:-}" ]]; then
    [[ "${DDASH_NONINTERACTIVE:-0}" != 1 ]] || fail 'Set WORKSPACE_ROOT for non-interactive use'
    read -r -p "Workspace directory [$HOST_HOME/ddash-workspace]: " WORKSPACE_ROOT </dev/tty
    WORKSPACE_ROOT="${WORKSPACE_ROOT:-$HOST_HOME/ddash-workspace}"
  fi
  if [[ -z "${DASHBOARD_PASSWORD:-}" ]]; then
    [[ "${DDASH_NONINTERACTIVE:-0}" != 1 ]] || fail 'Set DASHBOARD_PASSWORD for non-interactive use'
    read -r -s -p 'Dashboard password: ' DASHBOARD_PASSWORD </dev/tty
    printf '\n' >/dev/tty
  fi
  [[ -n "$DASHBOARD_PASSWORD" ]] || fail 'DASHBOARD_PASSWORD must not be empty'
  export DASHBOARD_PASSWORD WORKSPACE_ROOT ORIGIN
}

validate_configuration() {
  local value
  for value in "$WORKSPACE_ROOT" "$DOCKER_SOCKET" "${SSH_AUTH_SOCK:-/unused}"; do
    [[ "$value" == /* && "$value" != *,* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] \
      || fail 'Bind sources must be absolute Docker-host paths without commas or newlines'
  done
  for value in "${DDASH_DEV_BOOTSTRAP:-0}" "${DDASH_SSH_DIRECTORY:-0}" "${DDASH_NONINTERACTIVE:-0}" "${DDASH_CREATE_WORKSPACE:-1}"; do
    [[ "$value" == 0 || "$value" == 1 ]] || fail 'DDASH_* switches must be 0 or 1'
  done
}

prepare_arguments() {
  [[ "${DDASH_CREATE_WORKSPACE:-1}" == 0 ]] || mkdir -p -- "$WORKSPACE_ROOT"
  ARGS=(--env DASHBOARD_PASSWORD --env HOST_USER --env HOST_UID --env HOST_GID --env HOST_HOME
    --env WORKSPACE_ROOT --env ORIGIN --env "HOST_HOSTNAME=${HOSTNAME:-}"
    --mount "type=bind,source=$WORKSPACE_ROOT,target=$WORKSPACE_ROOT"
    --mount "type=bind,source=$DOCKER_SOCKET,target=/var/run/docker.sock"
    --volume dashboard_data:/data --volume ddash_zsh_data:/dashboard-history)
  if [[ -n "${SSH_AUTH_SOCK:-}" ]]; then
    export SSH_AUTH_SOCK
    ARGS+=(--env SSH_AUTH_SOCK --mount "type=bind,source=$SSH_AUTH_SOCK,target=$SSH_AUTH_SOCK,readonly")
  fi
  if [[ "${DDASH_SSH_DIRECTORY:-0}" == 1 ]]; then
    ARGS+=(--mount "type=bind,source=$HOST_HOME/.ssh,target=$HOST_HOME/.ssh,readonly")
  fi
  HOOK=()
  [[ "${DDASH_DEV_BOOTSTRAP:-0}" != 1 ]] || HOOK=(dev-bootstrap)
}

main() {
  case "${1:-}" in
    --help|-h) echo 'Usage: bash scripts/run-dashboard.sh. See scripts/README.md. DDASH_NONINTERACTIVE=1 disables prompts.'; return ;;
    '') ;;
    *) fail "Unknown option: $1" ;;
  esac
  resolve_identity
  read_configuration
  validate_configuration
  prepare_arguments
  printf 'Operator: %s (%s:%s), home %s\n' "$HOST_USER" "$HOST_UID" "$HOST_GID" "$HOST_HOME"
  printf 'dev-bootstrap: %s (1=enabled, 0=disabled)\n' "${DDASH_DEV_BOOTSTRAP:-0}"
  echo 'All bind sources must exist on the Docker host. SSH resources are read-only.'
  docker pull "$IMAGE"
  exec docker run --rm "${ARGS[@]}" \
    -p "${DASHBOARD_BIND_ADDRESS:-127.0.0.1}:3000:3000" \
    --name devcontainer-dashboard "$IMAGE" "${HOOK[@]}"
}

main "$@"
