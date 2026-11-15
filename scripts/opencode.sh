#!/usr/bin/env bash
# Attach normal dashboard terminal commands to its one owned OpenCode server.
set -euo pipefail

# The runtime publishes the endpoint only after an authenticated readiness check.
main() {
    local endpoint
    if [[ ! -s /dashboard-ai/server-url || ! -s /dashboard-ai/server-password ]]; then
        echo 'Dashboard OpenCode is not ready. Check AI status and container logs.' >&2
        exit 1
    fi
    endpoint=$(cat /dashboard-ai/server-url)
    [[ "$endpoint" =~ ^http://127\.0\.0\.1:[1-9][0-9]{0,4}$ ]] || exit 1
    export OPENCODE_PASSWORD
    OPENCODE_PASSWORD=$(cat /dashboard-ai/server-password)
    exec "$HOME/.opencode/bin/opencode" --server "$endpoint" "$@"
}
main "$@"
