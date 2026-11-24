# Host SSH agent forwarding

This is the SSH contract for issue #63. It supersedes the former SSH-directory
mount instructions in deployment history and handoff notes.

## Authentication path

```text
Existing Docker-host agent
  -> same-path socket bind in DevHarbour
  -> /tmp/devharbour-ssh-agent.sock in each managed devcontainer
```

DevHarbour does not start an agent. It does not copy private keys. It does not
mount the host `.ssh` directory. `SSH_AUTH_SOCK` identifies the existing agent on
the Docker host. There is no `SSH_SOCKET` configuration variable.

Run the launcher from the native Linux Docker host with that variable exported.
Keep the existing agent running. If it has no loaded identities, DevHarbour can
start, but SSH authentication will not work until the operator loads an identity.
The launcher fails when the variable is absent. The entrypoint checks the socket
and agent protocol as the configured non-root operator before hooks or the server
start. A missing, stale, inaccessible or unresponsive socket stops startup.

```bash
ssh-add -l
bash scripts/run-dashboard.sh --build \
  --workspace "$HOME/git.workspaces" \
  --ssh-known-hosts "$HOME/.ssh/known_hosts"
```

Do not use sudo unless necessary. If sudo is necessary, preserve the intended
operator's `SSH_AUTH_SOCK` through your sudo policy. Do not discover another user's
agent or change the socket permissions to make startup pass.

The path must exist on the Docker daemon host, not only in a browser, an SSH client
or an outer VS Code devcontainer. A VS Code proxy socket inside another container
is not automatically a host bind source. Remote Docker agents and Docker Desktop
host-agent bridges are not implemented by this native-host contract. Do not use a
remote browser client's agent in place of the selected Docker-host agent.

The supported socket path grammar is absolute paths containing letters, digits,
slashes, underscores, periods, spaces and hyphens, without `.` or `..` segments.
This avoids shell, Docker mount and Compose interpolation ambiguities.

## Managed devcontainers

Build and rebuild actions run `scripts/devcontainer-agent.mjs` with literal argv.
The runner does the following:

1. Check the dashboard's access to the existing agent.
2. Read the selected JSONC devcontainer configuration without executing it.
3. Write a private temporary override outside the repository.
4. Add a bind from the daemon-host socket to `/tmp/devharbour-ssh-agent.sock`.
5. Set `SSH_AUTH_SOCK` in both `containerEnv` and `remoteEnv`.
6. Run `devcontainer up` with the original `--config` and temporary `--override-config`.
7. Check agent access with `devcontainer exec` as the effective remote user.
8. Remove the temporary override after the process finishes.

The original config remains the base for relative Dockerfiles, Features, Compose
files, substitutions and identity labels. Tracked repository files do not change.
The CLI merges the mount and container environment into image/Dockerfile and
Compose devcontainers. Only the selected development service receives this mount,
not every service in its Compose project.

The runtime container environment makes the socket available to ordinary Docker
exec sessions, including DevHarbour Terminal and OpenCode. The explicit remote
environment also covers lifecycle and CLI remote commands. Login scripts and
repository lifecycle scripts remain trusted configuration and can change their
own environment; do not overwrite `SSH_AUTH_SOCK` there.

The devcontainer needs a POSIX shell and `ssh-add` from its OpenSSH client package
for the verification step. Missing tooling or remote-user access produces a failed
managed build with a diagnostic. The runner never chmods or chowns the host socket,
changes `remoteUser`, or silently runs the check as root. Configure the remote UID
correctly, normally with `updateRemoteUserUID`, if it differs from the host operator.

Explicit mounts sourced from `${localEnv:SSH_AUTH_SOCK}` or the selected socket are
replaced by the managed mount. An unrelated mount at the reserved target is refused.
An explicit `.ssh` directory mount in `devcontainer.json` `mounts` is refused, with
migration guidance. This check is not a security policy engine: review `runArgs`,
Compose volumes, Features, image metadata and lifecycle commands separately. They
can expose credentials independently and remain trusted operator configuration.

## Migration and lifecycle

- Remove `--ssh-dir` and `--no-ssh-dir` from launch commands. Both now report removal.
- Remove private-key directory binds from repository devcontainer configurations.
- Remove obsolete socket mounts when they are declared in Compose or `runArgs`.
- Keep the original host agent running and export its socket before launch.
- Recreate DevHarbour to apply its changed mounts.
- Use an explicit rebuild to apply mounts to an existing devcontainer.

An ordinary build/start does not silently replace an existing container. If that
container lacks the managed socket, verification fails and asks for an explicit
rebuild. Verification failure does not roll back or remove the container. Normal
rebuild replacement warnings and writable-layer loss still apply.

A single-socket bind pins the socket inode. Adding or removing identities in the
same agent works without recreation. Replacing the socket inode or selecting a
new socket path requires recreation of DevHarbour and affected devcontainers.
There is no background agent discovery, relay or transparent socket recovery.
Browser disconnection does not end the agent or the persistent build process.

## Host-key trust is separate

`--ssh-known-hosts PATH` mounts one trusted file at `/etc/ssh/ssh_known_hosts` in the
dashboard, read-only. It does not mount the enclosing directory or private keys.
The entrypoint checks that the selected file is regular and readable. The file
provides trust for dashboard Git and the optional bootstrap hook.

This flag does not automatically provision trust inside managed devcontainers.
Use an image trust store or an explicit known_hosts-only configuration there.
Verify fingerprints through a trusted channel before adding entries. Do not use
`StrictHostKeyChecking=no`, accept-new as an unreviewed trust policy, or unverified
`ssh-keyscan` output as a substitute for trust.

The bootstrap hook always requires the forwarded agent. A private key file or a
custom SSH command is not an automatic fallback for a missing agent.

## Trust boundary

A read-only key mount still permits key extraction. Agent forwarding prevents
that file exposure, but a connected process can request authentication/signing
from the agent. A read-only socket bind does not restrict the agent protocol.
Use agent lifetimes, confirmation constraints and trusted containers as appropriate.
DevHarbour already grants broad Docker operator capability; this is not tenant
isolation or protection against an operator with Docker-host access.

## Validation before merge

Source and mocked checks:

```bash
npm run test:deployment
npm run test:ssh
npm run check
npm run lint
```

The mocked tests do not establish Docker or SSH authentication behavior. On a
disposable native Linux Docker host:

1. Record the candidate commit and Dev Containers CLI version.
2. Run `ssh-add -L` on the host and inside DevHarbour as its configured operator.
3. Create an image/Dockerfile devcontainer through the dashboard build action.
4. Compare `ssh-add -L` in that devcontainer as its effective remote user.
5. Repeat with a Compose devcontainer and a named configuration with relative paths.
6. Check `SSH_AUTH_SOCK` and a permitted Git operation in Terminal and OpenCode.
7. Repeat with an empty agent, inaccessible socket, stale socket and wrong remote UID.
8. Check a container that predates the mount, then explicitly rebuild it.
9. Replace the agent socket and confirm the documented recreation requirement.
10. Disconnect and reattach during a build, then check explicit cancellation.
11. Confirm there is no host `.ssh` directory or private-key mount in either container.
12. Confirm strict host-key rejection for an unknown server.

`scripts/tests/container-smoke.sh` is a legacy fixture that still uses fake `.ssh`
directory data. It must be migrated before it can validate this new contract; do
not interpret it as agent-forwarding evidence. No runtime validation was performed
while preparing the GitHub-only draft PR.
