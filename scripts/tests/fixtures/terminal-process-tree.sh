#!/usr/bin/env bash
# Disposable local process-tree fixture. The test owns the parent and every child.
set -euo pipefail

# Keep a child alive so cancellation tests can verify descendants, not only the PTY shell.
main() {
  sleep 300 &
  local child=$!
  printf 'TREE parent=%s child=%s\n' "$$" "$child"
  wait "$child"
}

main "$@"
