#!/bin/bash
# Install the optional dev-bootstrap provider before dashboard server startup.
# Run as the configured non-root operator with HOME and PATH already established.
# The entrypoint has already verified the forwarded host SSH agent. Trusted server
# host keys are separate: use --ssh-known-hosts, an image trust store or an operator
# hook. Never copy private keys or disable strict host-key checking.
set -euo pipefail

# Print an actionable error to stderr and exit unsuccessfully.
fail() { printf '[dev-bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

# Require the forwarded agent and retain strict SSH defaults, including custom commands.
configure_ssh() {
  [[ -S "${SSH_AUTH_SOCK:-}" ]] ||
    fail 'Installation was enabled but no SSH agent socket is available. Forward the Docker-host SSH_AUTH_SOCK; private-key directory mounts are not supported.'
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes -o StrictHostKeyChecking=yes"
}

# Clone with agent authentication and separately provisioned host-key trust.
clone_provider() {
  echo '[dev-bootstrap] Cloning provider with strict host-key checking.'
  git clone -- "$DEVBOOTSTRAP_REPO" "$DEVBOOTSTRAP_DIR" \
    || fail 'Clone failed. Check GitLab repository access, the host SSH agent and trusted known_hosts.'
}

# Run the installer, which can pull an existing checkout, and require its shim.
install_provider() {
  [[ -f "$DEVBOOTSTRAP_DIR/install.sh" && -x "$DEVBOOTSTRAP_DIR/install.sh" ]] \
    || fail "$DEVBOOTSTRAP_DIR/install.sh is missing or not executable; repair this installation before retrying"
  echo '[dev-bootstrap] Installing provider.'
  "$DEVBOOTSTRAP_DIR/install.sh" || fail 'Provider installer failed; dashboard startup stopped'
  [[ -x "$HOME/.local/bin/devbootstrap" ]] && command -v devbootstrap >/dev/null \
    || fail 'Installer returned success but devbootstrap is not on PATH; check the provider installation'
  echo '[dev-bootstrap] Provider installed and devbootstrap is available.'
}

# Run phases in order. Authentication is always through the existing host agent.
main() {
  [[ -n "${HOME:-}" && "$HOME" == /* ]] || fail 'HOME must be an absolute runtime home'
  DEVBOOTSTRAP_DIR="$HOME/.devbootstrap"
  DEVBOOTSTRAP_REPO='git@gitlab.com:TernDev/common/dev-bootstrap.git'
  export PATH="$HOME/.local/bin:${PATH}"
  configure_ssh
  if [[ ! -e "$DEVBOOTSTRAP_DIR" ]]; then clone_provider; fi
  install_provider
}

main "$@"
