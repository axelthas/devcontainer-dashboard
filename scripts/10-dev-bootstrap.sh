#!/bin/bash
# Optional bundled hook: command: ["dev-bootstrap"].
# Runs as the configured host-matched operator, never as root.
# Agent and SSH-directory mounts use the same absolute paths as the host.
set -euo pipefail
DEVBOOTSTRAP_DIR="${HOME}/.devbootstrap"
DEVBOOTSTRAP_REPO="git@gitlab.com:TernDev/common/dev-bootstrap.git"
if [[ -d "$DEVBOOTSTRAP_DIR" ]]; then
  exec "$DEVBOOTSTRAP_DIR/install.sh"
fi
if [[ -S "${SSH_AUTH_SOCK:-}" ]] || \
   [[ -f "$HOME/.ssh/id_rsa" || -f "$HOME/.ssh/id_ed25519" || -f "$HOME/.ssh/id_ecdsa" ]]; then
  # Do not chmod or append known_hosts on a possibly read-only host SSH mount.
  # Unknown keys require explicit operator trust, not unauthenticated keyscan.
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o StrictHostKeyChecking=yes}"
  git clone "$DEVBOOTSTRAP_REPO" "$DEVBOOTSTRAP_DIR"
  exec "$DEVBOOTSTRAP_DIR/install.sh"
fi
echo "[dev-bootstrap] No SSH credentials available; setup skipped."
echo "[dev-bootstrap] Forward SSH_AUTH_SOCK or select a read-only HOST_HOME/.ssh mount."
