#!/bin/bash
# Install the optional dev-bootstrap provider before dashboard server startup.
#
# The entrypoint selects this hook only when bootstrap was explicitly enabled.
# Run as the configured non-root operator with HOME and PATH already established.
# Requires Git, SSH access and the provider installer dependencies in the image.
# Clones into HOME/.devbootstrap or reruns that checkout's installer. The installer
# can update the checkout and access the network even when it already exists.
# Requires the HOME/.local/bin/devbootstrap shim after installation. Any missing
# credentials, clone/install failure or missing shim stops startup with a diagnostic.
# Default SSH uses batch mode and strict host-key checking; host SSH files are not
# modified. See scripts/README.md for read-only SSH mounts and persistence limits.

set -euo pipefail

# Print an actionable error to stderr and exit unsuccessfully. All callers stop the script.
fail() { printf '[dev-bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

# Require available SSH credentials/configuration, apply strict defaults, and clone the provider.
# Do not modify host SSH files or create trust automatically; report a failed clone explicitly.
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

# Validate and run the provider installer, then require its executable shim on PATH.
# The installer may pull an existing checkout; failure prevents dashboard startup.
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

# Run the script phases in order. Stop on a failed phase before later work can start.
main() {
  [[ -n "${HOME:-}" && "$HOME" == /* ]] || fail 'HOME must be an absolute runtime home'
  DEVBOOTSTRAP_DIR="$HOME/.devbootstrap"
  DEVBOOTSTRAP_REPO='git@gitlab.com:TernDev/common/dev-bootstrap.git'
  export PATH="$HOME/.local/bin:${PATH}"
  if [[ ! -e "$DEVBOOTSTRAP_DIR" ]]; then clone_provider; fi
  install_provider
}

main "$@"
