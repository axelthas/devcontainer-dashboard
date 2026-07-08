#!/bin/sh
set -e

# Add ddash to the host's Docker group so it can access /var/run/docker.sock.
# The host Docker group GID varies by machine, so we resolve it at runtime.
DOCKER_GROUP=""
if [ -S /var/run/docker.sock ]; then
    DOCKER_GID=$(stat -c '%g' /var/run/docker-host.sock)
    if ! getent group "$DOCKER_GID" > /dev/null 2>&1; then
        sudo groupadd --gid "$DOCKER_GID" docker-host
    fi
    DOCKER_GROUP=$(getent group "$DOCKER_GID" | cut -d: -f1)
    if ! id -nG ddash | grep -qw "$DOCKER_GROUP"; then
        sudo usermod -aG "$DOCKER_GROUP" ddash
    fi
fi

# Optional first argument: the short name of a bundled hook script to run.
# Bundled hooks live in /opt/dashboard/hooks/ and follow the naming convention
# "<NN>-<name>.sh". Pass the descriptive suffix without prefix or extension, e.g.:
#
#   docker-entrypoint.sh dev-bootstrap
#
# maps to /opt/dashboard/hooks/10-dev-bootstrap.sh.
#
# The named hook runs BEFORE any volume-mounted hooks in /docker-entrypoint.d/.
# Omit the argument for normal startup without any named hook.
if [ -n "$1" ]; then
    HOOKS_DIR=/opt/dashboard/hooks
    HOOK_NAME="$1"
    # Find the first file matching *-<name>.sh (alphabetical order)
    HOOK_FILE=""
    for f in "$HOOKS_DIR"/*-"$HOOK_NAME".sh; do
        [ -f "$f" ] && HOOK_FILE="$f" && break
    done
    if [ -z "$HOOK_FILE" ]; then
        echo "[entrypoint] ERROR: No bundled hook found for '$HOOK_NAME' in $HOOKS_DIR"
        echo "[entrypoint] Available hooks:"
        for f in "$HOOKS_DIR"/*.sh; do
            [ -f "$f" ] && echo "[entrypoint]   $(basename "$f")"
        done
        exit 1
    fi
    echo "[entrypoint] Running bundled hook: $HOOK_FILE"
    "$HOOK_FILE"
fi

# Run any operator-provided hook scripts before starting the server.
# Drop executable .sh files into /docker-entrypoint.d/ via a volume mount.
# Files are executed in alphabetical order; use numeric prefixes (e.g. 10-foo.sh)
# to control ordering. Non-executable files are silently skipped.
if [ -d /docker-entrypoint.d ]; then
    for f in /docker-entrypoint.d/*.sh; do
        [ -f "$f" ] && [ -x "$f" ] && echo "[entrypoint] Running $f" && "$f"
    done
fi

# Use sg to start node with the docker group active in the process credentials.
# usermod updates /etc/group but the current shell doesn't pick up new groups
# without a session reload.
if [ -n "$DOCKER_GROUP" ]; then
    exec sg "$DOCKER_GROUP" -c "exec node build/server.js"
fi
exec node build/server.js
