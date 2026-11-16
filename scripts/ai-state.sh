#!/usr/bin/env bash
# Prepare private AI storage and hold its database lock for the dashboard lifetime.
set -euo pipefail

# Stop before modifying an unexpected filesystem or existing home entry.
fail() { printf '[ai-state] ERROR: %s\n' "$*" >&2; exit 1; }

# Link an absent home entry. Never overwrite existing user configuration.
link_home() {
    local source="$1" target="$2"
    mkdir -p -- "$source" "$(dirname -- "$target")"
    if [[ -L "$target" ]]; then
        [[ "$(readlink -- "$target")" == "$source" ]] || fail "Unexpected link at $target"
    elif [[ -e "$target" ]]; then
        fail "Existing state at $target. Migrate it explicitly while stopped."
    else
        ln -s -- "$source" "$target"
    fi
}

# Use the dev-bootstrap storage layout without its private provider/auth configuration.
prepare_state() {
    [[ ! -L /dashboard-ai && "$(findmnt -n -o TARGET -T /dashboard-ai)" == /dashboard-ai ]] ||
        fail 'Mount a dedicated named volume at /dashboard-ai.'
    umask 077
    exec 9>/dashboard-ai/.runtime.lock
    flock -n 9 || fail 'Another dashboard is using this AI volume. Stop it before reuse.'
    export XDG_DATA_HOME=/dashboard-ai/data
    export XDG_STATE_HOME=/dashboard-ai/state
    export XDG_CONFIG_HOME=/dashboard-ai/config
    export XDG_CACHE_HOME=/dashboard-ai/cache
    export OPENCODE_DB=/dashboard-ai/data/opencode/opencode.db
    export OPENCHAMBER_DATA_DIR=/dashboard-ai/openchamber
    mkdir -p "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$OPENCHAMBER_DATA_DIR"
    link_home /dashboard-ai/home "$HOME/.opencode"
    link_home /dashboard-ai/data/opencode "$HOME/.local/share/opencode"
    link_home /dashboard-ai/state/opencode "$HOME/.local/state/opencode"
    link_home /dashboard-ai/config/opencode "$HOME/.config/opencode"
    link_home /dashboard-ai/config/openchamber "$HOME/.config/openchamber"
    mkdir -p "$HOME/.opencode/bin"
    if [[ ! -e "$HOME/.opencode/bin/opencode" ]]; then
        cp /opt/dashboard-ai/opencode "$HOME/.opencode/bin/opencode"
        chmod 700 "$HOME/.opencode/bin/opencode"
    fi
    local version
    version=$("$HOME/.opencode/bin/opencode" --version)
    version="${version##* }"
    version="${version#v}"
    [[ "$version" == 2.* ]] || fail 'The persisted OpenCode executable must be v2.'
}

# Keep descriptor 9 open across exec. The kernel releases the lock when Node exits.
main() {
    prepare_state
    exec "$@"
}
main "$@"
