#!/usr/bin/env bash
# Prepare private, persistent AI state as the resolved dashboard operator.
# Hold an exclusive volume lock for the complete server lifetime. Never copy a
# live database from another container or migrate an old container implicitly.
set -euo pipefail

# Stop without exposing credentials.
fail() { printf '[local-ai] ERROR: %s\n' "$*" >&2; exit 1; }

# Refuse container-layer storage: rebuilding must not silently discard sessions.
validate_storage() {
    [[ "$(findmnt -n -o TARGET -T /dashboard-ai)" == /dashboard-ai ]] ||
        fail 'Mount a dedicated named volume at /dashboard-ai.'
    [[ -w /dashboard-ai && ! -L /dashboard-ai ]] || fail 'AI volume is not writable.'
    exec 9>/dashboard-ai/.runtime.lock
    flock -n 9 || fail 'Another dashboard is using this AI volume. Stop it before reuse.'
    umask 077
}

# Link only missing home entries. Existing state must be migrated explicitly.
link_home() {
    local source="$1" target="$2"
    mkdir -p -- "$source" "$(dirname -- "$target")"
    if [[ -L "$target" ]]; then
        [[ "$(readlink -- "$target")" == "$source" ]] || fail "Unexpected link: $target"
    elif [[ -e "$target" ]]; then
        fail "Existing state at $target; back it up and migrate it explicitly."
    else
        ln -s -- "$source" "$target"
    fi
}

# Use the same paths for the server, OpenChamber and dashboard terminal commands.
prepare_state() {
    export XDG_DATA_HOME=/dashboard-ai/data
    export XDG_STATE_HOME=/dashboard-ai/state
    export XDG_CONFIG_HOME=/dashboard-ai/config
    export XDG_CACHE_HOME=/dashboard-ai/cache
    export OPENCODE_DB=/dashboard-ai/data/opencode/opencode.db
    mkdir -p "$XDG_DATA_HOME/opencode" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
    if [[ ! -s /dashboard-ai/service-password ]]; then
        node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' > /dashboard-ai/service-password
    fi
    chmod 600 /dashboard-ai/service-password
    export OPENCODE_PASSWORD="$(cat /dashboard-ai/service-password)"
    export OPENCODE_SERVER_PASSWORD="$OPENCODE_PASSWORD"
    link_home /dashboard-ai/opencode "$HOME/.opencode"
    link_home /dashboard-ai/config/openchamber "$HOME/.config/openchamber"
    link_home /dashboard-ai/config/opencode "$HOME/.config/opencode"
    link_home /dashboard-ai/data/opencode "$HOME/.local/share/opencode"
    link_home /dashboard-ai/state/opencode "$HOME/.local/state/opencode"
    # Some OpenChamber releases keep CLI metadata outside XDG paths.
    link_home /dashboard-ai/openchamber "$HOME/.openchamber"
    mkdir -p "$HOME/.opencode/bin"
    if [[ ! -e "$HOME/.opencode/bin/opencode" ]]; then
        cp /opt/dashboard-ai/opencode "$HOME/.opencode/bin/opencode"
        chmod 700 "$HOME/.opencode/bin/opencode"
    fi
    local version
    version=$("$HOME/.opencode/bin/opencode" --version)
    [[ "$version" =~ (^|[^0-9])2\.[0-9]+ ]] || fail 'The persisted OpenCode binary is not v2.'
    export PATH="$HOME/.opencode/bin:$PATH"
}

# Keep descriptor 9 open across exec so the kernel releases the lock on exit.
main() {
    validate_storage
    prepare_state
    exec "$@"
}
main "$@"
