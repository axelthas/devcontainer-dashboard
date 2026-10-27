#!/bin/sh
set -eu

fail() {
    echo "[entrypoint] ERROR: $*" >&2
    exit 1
}

[ -n "${DASHBOARD_PASSWORD:-}" ] || fail "DASHBOARD_PASSWORD must be set to a non-empty value"
[ "$(id -u)" = 0 ] || fail "Start the entrypoint as root; it drops privileges before hooks and the server"
case "${HOST_USER:-}" in ''|*[!a-zA-Z0-9_-]*|[!a-zA-Z_]*) fail "HOST_USER must be a valid non-root account name" ;; esac
for number in "${HOST_UID:-}" "${HOST_GID:-}"; do
    case "$number" in ''|*[!0-9]*) fail "HOST_UID and HOST_GID must be numeric" ;; esac
done
[ "$HOST_UID" -gt 0 ] && [ "$HOST_GID" -gt 0 ] || fail "Root UID/GID is not supported"
case "$HOST_UID:$HOST_GID" in 0*|*:0*) fail "Identity IDs must not have leading zeroes" ;; esac
[ "$HOST_UID" -le 2147483647 ] && [ "$HOST_GID" -le 2147483647 ] || fail "Identity IDs are out of range"
[ "$HOST_USER" != root ] || fail "Root operator identity is not supported"
case "${HOST_HOME:-}" in /*) ;; *) fail "HOST_HOME must be an absolute Docker-host home path" ;; esac
case "$HOST_HOME/" in
    /|//|*/../*|*/./*|*///*|/app/*|/data/*|/opt/*|/etc/*|/usr/*|/var/*|/root/*|/bin/*|/sbin/*|/dev/*|/proc/*|/sys/*|/run/*|/tmp/*)
        fail "HOST_HOME must be a dedicated non-system home path" ;;
esac
case "$HOST_HOME" in *[!a-zA-Z0-9_./\ -]*) fail "HOST_HOME contains unsupported characters" ;; esac

DOCKER_SOCKET=/var/run/docker.sock
[ -S "$DOCKER_SOCKET" ] || fail "$DOCKER_SOCKET is missing or is not a Unix socket; mount the host Docker socket here"
DOCKER_GID=$(stat -Lc '%g' "$DOCKER_SOCKET") || fail "Cannot read the group ID of $DOCKER_SOCKET"
case "$DOCKER_GID" in ''|*[!0-9]*) fail "Invalid group ID for $DOCKER_SOCKET" ;; esac

# Never rename or take over an unrelated image account.
ACCOUNT=$(getent passwd "$HOST_USER" || true)
UID_ACCOUNT=$(getent passwd "$HOST_UID" || true)
if [ -n "$UID_ACCOUNT" ]; then
    [ "$(printf '%s' "$UID_ACCOUNT" | cut -d: -f1)" = "$HOST_USER" ] \
        || fail "HOST_UID $HOST_UID belongs to another image account"
fi
if [ -n "$ACCOUNT" ]; then
    [ "$(printf '%s' "$ACCOUNT" | cut -d: -f3)" = "$HOST_UID" ] \
        && [ "$(printf '%s' "$ACCOUNT" | cut -d: -f4)" = "$HOST_GID" ] \
        && [ "$(printf '%s' "$ACCOUNT" | cut -d: -f6)" = "$HOST_HOME" ] \
        || fail "Existing HOST_USER does not match HOST_UID, HOST_GID and HOST_HOME"
fi
if ! getent group "$HOST_GID" >/dev/null 2>&1; then
    groupadd --gid "$HOST_GID" "dashboard-$HOST_GID" || fail "Cannot create operator primary group"
fi
if [ -z "$ACCOUNT" ]; then
    useradd --no-create-home --uid "$HOST_UID" --gid "$HOST_GID" \
        --home-dir "$HOST_HOME" --shell /bin/zsh "$HOST_USER" || fail "Cannot create operator account"
fi
if ! getent group "$DOCKER_GID" >/dev/null 2>&1; then
    groupadd --gid "$DOCKER_GID" "docker-host-$DOCKER_GID" || fail "Cannot create Docker socket group"
fi
DOCKER_GROUP=$(getent group "$DOCKER_GID" | cut -d: -f1)
usermod -aG "$DOCKER_GROUP" "$HOST_USER" || fail "Cannot add operator to Docker socket group"

# Validate the home before touching storage. It must remain container-private.
HOME_PARENT="$HOST_HOME"
while [ ! -e "$HOME_PARENT" ]; do HOME_PARENT=$(dirname "$HOME_PARENT"); done
[ "$(realpath "$HOME_PARENT")" = "$HOME_PARENT" ] || fail "HOST_HOME must not have symlink parents"
[ "$(findmnt -n -o TARGET -T "$HOME_PARENT")" = / ] || fail "Do not mount the host home or a parent; mount selected resources only"
if [ ! -e "$HOST_HOME" ]; then
    mkdir -p "$HOST_HOME"
fi
[ ! -L "$HOST_HOME" ] || fail "HOST_HOME must not be a symlink"
[ "$(realpath "$HOST_HOME")" = "$HOST_HOME" ] || fail "HOST_HOME must be canonical without symlink parents"
[ "$(findmnt -n -o TARGET -T "$HOST_HOME")" = / ] || fail "Do not mount the host home or a parent; mount selected resources only"
# Reserved for dashboard-owned named volumes, never HOME or host workspaces.
mkdir -p /data /dashboard-history
chown -hR -P "$HOST_UID:$HOST_GID" /data /dashboard-history
# Docker may create this container-private directory as root for a nested SSH mount.
chown "$HOST_UID:$HOST_GID" "$HOST_HOME"
printf '%s ALL=(root) NOPASSWD:ALL\n' "$HOST_USER" > /etc/sudoers.d/dashboard-operator
chmod 0440 /etc/sudoers.d/dashboard-operator
export HOME="$HOST_HOME" USER="$HOST_USER" LOGNAME="$HOST_USER" SHELL=/bin/zsh
export PATH="/opt/dashboard-tools/bin:$PATH"
export HISTFILE=/dashboard-history/.zsh_history

# runuser initializes supplementary groups and preserves the primary group.
exec runuser -u "$HOST_USER" -- /bin/sh -c '
    set -eu
    test -r /var/run/docker.sock && test -w /var/run/docker.sock || {
        echo "[entrypoint] ERROR: Docker socket is not readable and writable by $USER" >&2
        exit 1
    }
    test -w "$HOME" || { echo "[entrypoint] ERROR: HOME is not writable" >&2; exit 1; }
    for name in .zshrc .bashrc; do
        if [ ! -e "$HOME/$name" ] && [ ! -L "$HOME/$name" ]; then
            cp "/opt/dashboard-shell/$name" "$HOME/$name"
        fi
    done
    if [ -n "${1:-}" ]; then
        case "$1" in *[!a-zA-Z0-9_-]*) echo "Invalid bundled hook name" >&2; exit 1 ;; esac
        found=false
        for hook in /opt/dashboard/hooks/*-"$1".sh; do
            [ -f "$hook" ] || continue
            "$hook"
            found=true
            break
        done
        "$found" || { echo "Unknown bundled hook: $1" >&2; exit 1; }
    fi
    for hook in /docker-entrypoint.d/*.sh; do
        if [ -f "$hook" ] && [ -x "$hook" ]; then "$hook"; fi
    done
    exec node build/server.js
' dashboard-runtime "$@"
