#!/bin/sh
set -e

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
