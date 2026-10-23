#!/bin/sh
set -eu

fail() {
    echo "[entrypoint] ERROR: $*" >&2
    exit 1
}

# Fail before hooks can perform work or receive an invalid configuration.
[ -n "${DASHBOARD_PASSWORD:-}" ] || fail "DASHBOARD_PASSWORD must be set to a non-empty value"

# Dockerode and the Docker CLI both use this path. Mount the host socket here.
DOCKER_SOCKET=/var/run/docker.sock
[ -S "$DOCKER_SOCKET" ] || fail "$DOCKER_SOCKET is missing or is not a Unix socket; mount the host Docker socket here"
DOCKER_GID=$(stat -c '%g' "$DOCKER_SOCKET") || fail "Cannot read the group ID of $DOCKER_SOCKET"
case "$DOCKER_GID" in
    ''|*[!0-9]*) fail "Invalid group ID for $DOCKER_SOCKET" ;;
esac

if ! getent group "$DOCKER_GID" > /dev/null 2>&1; then
    sudo groupadd --gid "$DOCKER_GID" docker-host \
        || fail "Cannot create the Docker socket group (GID $DOCKER_GID)"
fi
DOCKER_GROUP=$(getent group "$DOCKER_GID" | cut -d: -f1)
[ -n "$DOCKER_GROUP" ] || fail "Cannot resolve the Docker socket group (GID $DOCKER_GID)"
sudo usermod -aG "$DOCKER_GROUP" ddash \
    || fail "Cannot add ddash to the Docker socket group"

# Check effective access with the same group credentials used for the server.
# Do not change host socket ownership or permissions.
sg "$DOCKER_GROUP" -c 'test -r /var/run/docker.sock && test -w /var/run/docker.sock' \
    || fail "$DOCKER_SOCKET is not readable and writable by ddash with group $DOCKER_GROUP"

# Ensure /data is owned by ddash (Docker named volumes start root-owned).
sudo mkdir -p /data && sudo chown ddash:ddash /data \
    || fail "Cannot prepare /data for ddash"

# Optional first argument selects a bundled hook, for example "dev-bootstrap".
if [ -n "${1:-}" ]; then
    HOOKS_DIR=/opt/dashboard/hooks
    HOOK_NAME="$1"
    HOOK_FILE=""
    for f in "$HOOKS_DIR"/*-"$HOOK_NAME".sh; do
        [ -f "$f" ] && HOOK_FILE="$f" && break
    done
    [ -n "$HOOK_FILE" ] || fail "No bundled hook found for '$HOOK_NAME' in $HOOKS_DIR"
    echo "[entrypoint] Running bundled hook: $HOOK_FILE"
    "$HOOK_FILE"
fi

# Operator hooks run in alphabetical order. Skip non-executable files.
if [ -d /docker-entrypoint.d ]; then
    for f in /docker-entrypoint.d/*.sh; do
        if [ -f "$f" ] && [ -x "$f" ]; then
            echo "[entrypoint] Running $f"
            "$f"
        fi
    done
fi

# usermod does not update the current shell's supplementary groups.
exec sg "$DOCKER_GROUP" -c 'exec node build/server.js'
