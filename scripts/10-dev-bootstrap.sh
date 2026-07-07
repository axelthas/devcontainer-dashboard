#!/bin/bash
# Bundled dev-bootstrap setup hook for devcontainer-dashboard.
#
# This script is shipped inside the production image at:
#   /opt/dashboard/hooks/10-dev-bootstrap.sh
#
# It is NOT activated by default. To enable it, add the following to your
# docker-compose.yml (or equivalent docker run flags):
#
#   volumes:
#     # Activate the hook by bind-mounting it into the entrypoint directory
#     - /opt/dashboard/hooks/10-dev-bootstrap.sh:/docker-entrypoint.d/10-dev-bootstrap.sh:ro
#     # Provide SSH access for the private GitLab clone (choose one or both):
#     - ${SSH_AUTH_SOCK}:/tmp/ssh-agent.socket:ro        # SSH agent socket
#     - ${HOME}/.ssh:/home/ddash/.ssh:ro                 # SSH key directory
#   environment:
#     SSH_AUTH_SOCK: /tmp/ssh-agent.socket               # required when using agent socket
#
# The script is idempotent: if ~/.devbootstrap already exists it re-runs the
# installer to pick up any upstream changes but does not re-clone.

set -e

DEVBOOTSTRAP_DIR="${HOME}/.devbootstrap"
DEVBOOTSTRAP_REPO="git@gitlab.com:TernDev/common/dev-bootstrap.git"

echo "[dev-bootstrap] Starting setup..."

# ── Already installed ────────────────────────────────────────────────────────
if [ -d "$DEVBOOTSTRAP_DIR" ]; then
    echo "[dev-bootstrap] $DEVBOOTSTRAP_DIR already exists, skipping clone."
    echo "[dev-bootstrap] Re-running install to apply any upstream changes..."
    "$DEVBOOTSTRAP_DIR/install.sh"
    exit 0
fi

# ── Check SSH availability ───────────────────────────────────────────────────
SSH_AVAILABLE=false

if [ -n "$SSH_AUTH_SOCK" ] && [ -S "$SSH_AUTH_SOCK" ]; then
    echo "[dev-bootstrap] SSH agent socket found at $SSH_AUTH_SOCK"
    SSH_AVAILABLE=true
elif [ -f "${HOME}/.ssh/id_rsa" ] \
    || [ -f "${HOME}/.ssh/id_ed25519" ] \
    || [ -f "${HOME}/.ssh/id_ecdsa" ]; then
    echo "[dev-bootstrap] SSH keys found in ${HOME}/.ssh"
    SSH_AVAILABLE=true
fi

if [ "$SSH_AVAILABLE" = "false" ]; then
    echo "[dev-bootstrap] WARNING: No SSH agent socket or SSH keys found."
    echo "[dev-bootstrap] Skipping dev-bootstrap setup. To enable, mount one of:"
    echo "[dev-bootstrap]   SSH agent:  -v \${SSH_AUTH_SOCK}:/tmp/ssh-agent.socket:ro -e SSH_AUTH_SOCK=/tmp/ssh-agent.socket"
    echo "[dev-bootstrap]   SSH keys:   -v \${HOME}/.ssh:/home/ddash/.ssh:ro"
    exit 0
fi

# ── Clone and install ────────────────────────────────────────────────────────

# Pre-accept the GitLab host key to avoid interactive prompts
mkdir -p "${HOME}/.ssh"
chmod 700 "${HOME}/.ssh"
ssh-keyscan -H gitlab.com >> "${HOME}/.ssh/known_hosts" 2>/dev/null || true

echo "[dev-bootstrap] Cloning $DEVBOOTSTRAP_REPO into $DEVBOOTSTRAP_DIR..."
if git clone "$DEVBOOTSTRAP_REPO" "$DEVBOOTSTRAP_DIR"; then
    echo "[dev-bootstrap] Clone successful. Running installer..."
    "$DEVBOOTSTRAP_DIR/install.sh"
    echo "[dev-bootstrap] Setup complete."
else
    echo "[dev-bootstrap] ERROR: Failed to clone $DEVBOOTSTRAP_REPO"
    echo "[dev-bootstrap] Ensure your SSH key has access to the GitLab repository."
    exit 1
fi
