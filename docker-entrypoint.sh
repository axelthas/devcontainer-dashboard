#!/bin/sh
set -e

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

exec node build/server.js
