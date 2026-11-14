#!/usr/bin/env bash
# Prepare only the dedicated AI volume, then use the existing identity entrypoint.
# That entrypoint remains authoritative for the host account and privilege drop.
set -euo pipefail

fail() { printf '[local-ai] ERROR: %s\n' "$*" >&2; exit 1; }

# Require an exact mount, no links, and a valid operator before touching ownership.
prepare_volume() {
    [[ "$(id -u)" == 0 ]] || fail 'Start as root; the normal entrypoint drops privileges.'
    [[ "${HOST_UID:-}" =~ ^[1-9][0-9]{0,9}$ && "${HOST_GID:-}" =~ ^[1-9][0-9]{0,9}$ ]] ||
        fail 'Non-root HOST_UID and HOST_GID are required.'
    (( HOST_UID <= 2147483647 && HOST_GID <= 2147483647 )) || fail 'Identity IDs are out of range.'
    [[ ! -L /dashboard-ai && "$(findmnt -n -o TARGET -T /dashboard-ai)" == /dashboard-ai ]] ||
        fail 'Mount a dedicated named volume at /dashboard-ai.'
    local owner
    owner=$(stat -c '%u' /dashboard-ai)
    [[ "$owner" == 0 || "$owner" == "$HOST_UID" ]] ||
        fail 'AI volume belongs to another UID. Migrate ownership explicitly while stopped.'
    # Do not recurse into persisted user files or follow symlinks as root.
    chown "$HOST_UID:$HOST_GID" /dashboard-ai
    chmod 700 /dashboard-ai
}

main() {
    if [[ "${LOCAL_AI_ENABLED:-}" == 1 ]]; then prepare_volume; fi
    exec /app/docker-entrypoint.sh "$@"
}
main "$@"
