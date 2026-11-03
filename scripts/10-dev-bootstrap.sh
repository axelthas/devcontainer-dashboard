#!/bin/bash
# Explicit install hook. Runs as the host-matched operator before the server.
set -euo pipefail

fail() { printf '[dev-bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

clone_provider() {
  if [[ ! -S "${SSH_AUTH_SOCK:-}" && ! -f "$HOME/.ssh/id_rsa" &&
        ! -f "$HOME/.ssh/id_ed25519" && ! -f "$HOME/.ssh/id_ecdsa" &&
        ! -f "$HOME/.ssh/config" && -z "${GIT_SSH_COMMAND:-}" ]]; then
    fail 'Installation was enabled but no SSH credentials/configuration are available. Forward an agent or mount HOST_HOME/.ssh read-only, including trusted GitLab known_hosts.'
  fi
  # Never modify a read-only mount or trust unauthenticated ssh-keyscan output.
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o StrictHostKeyChecking=yes}"
  echo '[dev-bootstrap] Cloning provider with strict host-key checking.'
  git clone -- "$DEVBOOTSTRAP_REPO" "$DEVBOOTSTRAP_DIR" \
    || fail 'Clone failed. Check GitLab repository access, agent/key availability and trusted known_hosts.'
}

install_provider() {
  [[ -f "$DEVBOOTSTRAP_DIR/install.sh" && -x "$DEVBOOTSTRAP_DIR/install.sh" ]] \
    || fail "$DEVBOOTSTRAP_DIR/install.sh is missing or not executable; repair this installation before retrying"
  echo '[dev-bootstrap] Installing provider.'
  # The installer also pulls an existing checkout.
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o StrictHostKeyChecking=yes}"
  "$DEVBOOTSTRAP_DIR/install.sh" || fail 'Provider installer failed; dashboard startup stopped'
  [[ -x "$HOME/.local/bin/devbootstrap" ]] && command -v devbootstrap >/dev/null \
    || fail 'Installer returned success but devbootstrap is not on PATH; check the provider installation'
  echo '[dev-bootstrap] Provider installed and devbootstrap is available.'
}

main() {
  [[ -n "${HOME:-}" && "$HOME" == /* ]] || fail 'HOME must be an absolute runtime home'
  DEVBOOTSTRAP_DIR="$HOME/.devbootstrap"
  DEVBOOTSTRAP_REPO='git@gitlab.com:TernDev/common/dev-bootstrap.git'
  export PATH="$HOME/.local/bin:${PATH}"
  if [[ ! -e "$DEVBOOTSTRAP_DIR" ]]; then clone_provider; fi
  install_provider
}

main "$@"
