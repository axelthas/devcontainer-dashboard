#!/bin/bash
# Generate, validate and run a host-integrated dashboard Compose deployment.
#
# Usage: bash scripts/run-dashboard-compose.sh; also supports curl | bash.
# Requires Bash, Docker Compose and access to the selected daemon-host socket.
# Reads HOST_* identity, workspace/password/origin and DDASH_* deployment options.
# Prompts read /dev/tty; DDASH_NONINTERACTIVE=1 disables every prompt.
# Writes identity, mount paths and origin to DDASH_CONFIG_DIR/docker-compose.yml.
# The password stays an environment reference. Validate a temporary configuration
# before replacing the previous file. Pull the image and run Compose in the
# foreground. Named storage survives container recreation; SSH mounts are read-only.
# See scripts/README.md for configuration and host-filesystem assumptions.

set -euo pipefail

# Print an actionable error to stderr and exit unsuccessfully. All callers stop the script.
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Identical in standalone launchers: curl | bash needs no companion file.
# Resolve the intended operator from explicit HOST_* values or passwd (SUDO_USER under sudo).
# Reject partial/invalid identities and export the complete contract for Docker/Compose.
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

# Return success for an empty local origin or HTTP(S) authority with an optional valid port.
# Reject paths, credentials, interpolation and out-of-range ports without printing secrets.
valid_origin() {
  local authority port
  [[ -n "$1" ]] || return 0
  [[ "$1" =~ ^https?://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[A-Fa-f0-9:]+\])(:[0-9]{1,5})?$ ]] || return 1
  # Strip the scheme first so bracketed IPv6 colons are not mistaken for a port.
  authority="${1#*://}"
  if [[ "$authority" =~ :([0-9]+)$ ]]; then
    port=$((10#${BASH_REMATCH[1]}))
    (( port >= 1 && port <= 65535 )) || return 1
  fi
  return 0
}

# Read and normalize the origin. Retry invalid interactive input; fail unattended input immediately.
read_origin() {
  local answer
  DASHBOARD_ORIGIN="${ORIGIN:-${DDASH_ORIGIN:-}}"
  if [[ "${DDASH_NONINTERACTIVE:-0}" == 1 ]]; then
    DASHBOARD_ORIGIN="${DASHBOARD_ORIGIN%/}"
    valid_origin "$DASHBOARD_ORIGIN" || fail 'Invalid ORIGIN: use an HTTP(S) origin without paths, credentials or interpolation'
    return
  fi
  while true; do
    read -r -p "Dashboard origin (blank for local HTTP) [$DASHBOARD_ORIGIN]: " answer </dev/tty
    answer="${answer:-$DASHBOARD_ORIGIN}"
    answer="${answer%/}"
    if valid_origin "$answer"; then DASHBOARD_ORIGIN="$answer"; return; fi
    echo 'Enter an HTTP(S) origin without paths, credentials, query or fragment; port must be 1..65535.' >/dev/tty
  done
}

# Resolve deployment settings and prompt only when allowed. Export password/workspace for Compose
# without persisting the password in generated configuration.
read_configuration() {
  IMAGE="${DASHBOARD_IMAGE:-ghcr.io/axelthas/devcontainer-dashboard:latest}"
  DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
  CONFIG_DIR="${DDASH_CONFIG_DIR:-${HOME}/.config/devcontainer-dashboard}"
  COMPOSE_FILE="$CONFIG_DIR/docker-compose.yml"
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
  read_origin
  if [[ -z "${DDASH_DEV_BOOTSTRAP+x}" && "${DDASH_NONINTERACTIVE:-0}" != 1 ]]; then
    local answer
    read -r -p 'Enable TernDev dev-bootstrap hook? [y/N]: ' answer </dev/tty
    DDASH_DEV_BOOTSTRAP=0
    [[ "${answer,,}" != y ]] || DDASH_DEV_BOOTSTRAP=1
  fi
  export DASHBOARD_PASSWORD WORKSPACE_ROOT
}

# Reject values that could break YAML or Compose interpolation; validate image and Boolean switches.
validate_configuration() {
  local value
  # Embedded values must not introduce YAML quoting or Compose expansion.
  for value in "$WORKSPACE_ROOT" "$DOCKER_SOCKET" "${SSH_AUTH_SOCK:-/unused}"; do
    [[ "$value" =~ ^/[a-zA-Z0-9_./\ -]+$ ]] || fail 'Unsupported bind path: use an absolute Docker-host path without interpolation or commas'
  done
  [[ "$IMAGE" =~ ^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$ ]] || fail 'Invalid DASHBOARD_IMAGE'
  for value in "${DDASH_DEV_BOOTSTRAP:-0}" "${DDASH_SSH_DIRECTORY:-0}" "${DDASH_NONINTERACTIVE:-0}" "${DDASH_CREATE_WORKSPACE:-1}"; do
    [[ "$value" == 0 || "$value" == 1 ]] || fail 'DDASH_* switches must be 0 or 1'
  done
}

# Print one long-form bind entry to stdout (source, target, optional readonly).
# Always disable automatic creation of missing host sources.
emit_bind() {
  printf "      - type: bind\n        source: '%s'\n        target: '%s'\n" "$1" "$2"
  [[ "${3:-}" != readonly ]] || printf '        read_only: true\n'
  printf '        bind:\n          create_host_path: false\n'
}

# Print the complete service/volume configuration, including selected SSH resources and hook.
# Render the password as an environment reference, never its literal value.
emit_compose() {
  cat <<YAML
# Generated by run-dashboard-compose.sh. Re-running replaces this configuration.
services:
  dashboard:
    image: '${IMAGE}'
    ports:
      - '\${DASHBOARD_BIND_ADDRESS:-127.0.0.1}:3000:3000'
    environment:
      DASHBOARD_PASSWORD: \${DASHBOARD_PASSWORD:?DASHBOARD_PASSWORD must be set}
      HOST_USER: '${HOST_USER}'
      HOST_UID: '${HOST_UID}'
      HOST_GID: '${HOST_GID}'
      HOST_HOME: '${HOST_HOME}'
      HOST_HOSTNAME: \${HOSTNAME:-}
      WORKSPACE_ROOT: '${WORKSPACE_ROOT}'
      PRESETS_FILE: /data/presets.json
      VSCODE_SSH_HOST: \${VSCODE_SSH_HOST:-}
      SERVICE_PROXY_ENABLED: \${SERVICE_PROXY_ENABLED:-}
      SERVICE_PROXY_HOST: \${SERVICE_PROXY_HOST:-}
      SERVICE_PROXY_PORTS: \${SERVICE_PROXY_PORTS:-}
YAML
  # Emit ORIGIN only when configured: adapter-node rejects an empty ORIGIN at startup.
  [[ -z "${DASHBOARD_ORIGIN:-}" ]] || printf "      ORIGIN: '%s'\n" "$DASHBOARD_ORIGIN"
  # Emit the optional socket in the same environment block, before the volumes list.
  [[ -z "${SSH_AUTH_SOCK:-}" ]] || printf "      SSH_AUTH_SOCK: '%s'\n" "$SSH_AUTH_SOCK"
  printf '    volumes:\n'
  emit_bind "$DOCKER_SOCKET" /var/run/docker.sock
  emit_bind "$WORKSPACE_ROOT" "$WORKSPACE_ROOT"
  printf '      - dashboard_data:/data\n      - ddash_zsh_data:/dashboard-history\n'
  [[ "${DDASH_SSH_DIRECTORY:-0}" != 1 ]] || emit_bind "$HOST_HOME/.ssh" "$HOST_HOME/.ssh" readonly
  [[ -z "${SSH_AUTH_SOCK:-}" ]] || emit_bind "$SSH_AUTH_SOCK" "$SSH_AUTH_SOCK" readonly
  [[ "${DDASH_DEV_BOOTSTRAP:-0}" != 1 ]] || printf '    command: ["dev-bootstrap"]\n'
  printf '    restart: unless-stopped\nvolumes:\n  dashboard_data:\n  ddash_zsh_data:\n'
}

# Render to a private temporary file, validate with Compose, then replace the saved configuration.
# If validation fails, remove the temporary file and keep the previous configuration intact.
write_configuration() {
  local temporary
  [[ "${DDASH_CREATE_WORKSPACE:-1}" == 0 ]] || mkdir -p -- "$WORKSPACE_ROOT"
  mkdir -p -- "$CONFIG_DIR"
  temporary=$(mktemp "$CONFIG_DIR/.compose-XXXXXX")
  # Complete and validate the replacement before replacing a working config.
  emit_compose > "$temporary"
  if ! docker compose -f "$temporary" config --quiet; then
    rm -f -- "$temporary"
    fail 'Compose validation failed; previous configuration retained'
  fi
  mv -- "$temporary" "$COMPOSE_FILE"
}

# Run the script phases in order. Stop on a failed phase before later work can start.
main() {
  case "${1:-}" in
    --help|-h) echo 'Usage: bash scripts/run-dashboard-compose.sh. See scripts/README.md. DDASH_NONINTERACTIVE=1 disables all prompts.'; return ;;
    '') ;;
    *) fail "Unknown option: $1" ;;
  esac
  resolve_identity
  read_configuration
  validate_configuration
  write_configuration
  printf 'Operator: %s (%s:%s), home %s\n' "$HOST_USER" "$HOST_UID" "$HOST_GID" "$HOST_HOME"
  printf 'dev-bootstrap: %s (1=enabled, 0=disabled)\n' "${DDASH_DEV_BOOTSTRAP:-0}"
  printf 'Compose file written to: %s\n' "$COMPOSE_FILE"
  echo "Dashboard address: ${DASHBOARD_ORIGIN:-http://${DASHBOARD_BIND_ADDRESS:-127.0.0.1}:3000}"
  echo 'All bind sources must exist on the Docker host; missing resources are not created by Compose.'
  docker compose -f "$COMPOSE_FILE" pull
  exec docker compose -f "$COMPOSE_FILE" up
}

main "$@"
