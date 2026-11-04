# Handoff: Simplify production deployment of the devcontainer-dashboard

Status: PLANNED, not started. Written 2026-11-04 from the devcontainer OpenCode session.
Saved in this repo as the staging file `tasks/simplify-deployment-handoff.md`; rename it to
`tasks/ISSUE-<N>-HANDOFF.md` once the issue exists (repo convention, see PR #22).
Execute this on the HOST (Docker daemon + host filesystem needed for validation).

This file is currently untracked so that PR #22's branch stays clean. `git switch -c`
carries untracked files along, so it survives branching in the same checkout. If the
host instance works in a different clone, copy this file over before branching.

## 0. First actions (do these before any code change)

1. Create the GitHub issue on `axelthas/devcontainer-dashboard`:

   Title: `Simplify production deployment: single args-driven launcher, remove Compose, relocate bootstrap plugins`

   Body summary (motivation + acceptance criteria):
   - Running the production build is too complex: three overlapping launchers, two
     deployment variants (direct Docker + Compose), env-var-driven configuration,
     duplicated code, and script names that don't convey registry-pull vs
     build-from-checkout.
   - Acceptance criteria:
     - One self-contained launcher (`scripts/run-dashboard.sh`, curl|bash safe) with
       two modes: default pulls the published registry image; `--build` builds the
       current checkout and runs a verified test instance.
     - All launcher inputs are explicit CLI flags (see flag grammar below); no
       `DDASH_*`, `DASHBOARD_*`, `WORKSPACE_ROOT`, `HOST_*` or `SERVICE_PROXY_*`
       env-var interface on the launcher (ambient `SSH_AUTH_SOCK`/`SUDO_USER` excepted).
     - Compose variant fully removed (`docker-compose.yml`,
       `scripts/run-dashboard-compose.sh`, compose-based tests and docs). The
       dashboard's compose-project _grouping display feature_ is untouched.
     - Bootstrap hook scripts live in `plugins/` in the repo and
       `/opt/dashboard/plugins/` in the container; hook command interface
       (`docker run image dev-bootstrap`) unchanged.
     - Full validation matrix passes on the host (section 8).

2. Branch and PR (stacked on top of PR #22):

   ```bash
   gh issue create --repo axelthas/devcontainer-dashboard --title '...' --body '...'
   git fetch origin
   git switch -c refactor/<N>-simplify-deployment origin/fix/https-service-embedding
   git mv tasks/simplify-deployment-handoff.md tasks/ISSUE-<N>-HANDOFF.md
   git commit -m "docs: deployment simplification handoff (<N>)"
   ```

   - `<N>` = the new issue number.
   - Base branch for the PR: `fix/https-service-embedding` (PR #22's head). PR #22
     itself is stacked on `fix/18-production-host-bind-mounts`.
   - Commit this handoff (renamed) as the first commit on the new branch, then keep
     updating it as a continuation log while the work proceeds.
   - `gh pr create --repo axelthas/devcontainer-dashboard --base fix/https-service-embedding --head refactor/<N>-simplify-deployment`
   - Note in the PR body: stacked PR, retarget to `main` after #22 merges. CI
     (`lint-and-test.yml`) only triggers on PRs targeting `main`, so the local
     validation matrix (section 8) is mandatory before requesting review.

## 1. Decision record (agreed with the operator)

1. Single launcher, two modes (kills all cross-script duplication; curl|bash needs
   each downloaded script self-contained).
2. Keep the name `scripts/run-dashboard.sh` for the single entrypoint.
3. Docker-host operator identity becomes CLI flags (auto-resolution from
   passwd/`SUDO_USER` unchanged as the default path).
4. Password: hidden `/dev/tty` prompt when interactive and unset, plus `--password`
   and `--password-file PATH` (CI; avoids argv/env exposure). Non-interactive runs
   must supply one of the two.
5. Bootstrap plugin scripts: `plugins/10-dev-bootstrap.sh` in the repo, and the
   container dir renamed to `/opt/dashboard/plugins/`.

## 2. Current state (for orientation)

- `scripts/run-dashboard.sh` — curl|bash installer; pulls
  `ghcr.io/axelthas/devcontainer-dashboard:latest`, runs foreground with `--rm`.
  Inputs via env vars (`WORKSPACE_ROOT`, `DASHBOARD_PASSWORD`, `DDASH_*` switches,
  `DASHBOARD_IMAGE`, `DOCKER_SOCKET`, `ORIGIN`/`DDASH_ORIGIN`,
  `DASHBOARD_BIND_ADDRESS`) and `/dev/tty` prompts.
- `scripts/run-production.sh` — Buildx build of the checkout (`--load`), unique
  test container (`DASHBOARD_TEST_NAME`), detached, health + in-container HTTP
  checks, retains resources on failure. Mixed interface: `--workspace --socket
--port --platform` args plus env vars (`DASHBOARD_PASSWORD`, `DDASH_*`,
  `DASHBOARD_TEST_PORT`, `DASHBOARD_HEALTH_TIMEOUT`, `DOCKER_DEFAULT_PLATFORM`,
  `SERVICE_PROXY_*` passthrough).
- `scripts/run-dashboard-compose.sh` + root `docker-compose.yml` — Compose variant
  (to be deleted). Compose is also the only path that forwards `VSCODE_SSH_HOST`
  and `SERVICE_PROXY_*` for registry-image deployments.
- `scripts/10-dev-bootstrap.sh` — bootstrap "plugin" hook; Dockerfile copies it to
  `/opt/dashboard/hooks/10-dev-bootstrap.sh`; entrypoint selects bundled hooks via
  glob `/opt/dashboard/hooks/*-<name>.sh`; operator hooks live separately at
  `/docker-entrypoint.d/*.sh`.
- Duplicated across the three launchers: `resolve_identity` (~18 lines, byte-equal,
  enforced by `deployment.test.mjs`), `fail()`, bind-path/switch validation,
  password prompting, docker-run argv assembly.
- Tests: `scripts/tests/run-production.test.mjs` (mocked docker/git/getent,
  iterates all three scripts, PTY test via util-linux `script`),
  `scripts/tests/deployment.test.mjs` (entrypoint contract + Compose contract +
  identity-contract comparison; fixture rewrites fixed paths incl.
  `/opt/dashboard/hooks`), `scripts/tests/bootstrap-hook.test.mjs`,
  `scripts/tests/container-smoke.sh` (real-Docker integration that drives BOTH
  compose paths to start its fixture; also builds the image, runs
  production-smoke with a sibling devcontainer fixture, checks ownership and
  fail-closed startup), `scripts/tests/production-smoke.mjs`,
  `scripts/tests/service-gateway.test.mjs`.
- npm scripts: `test:deployment` runs deployment + run-production + bootstrap-hook
  - socket-symlink tests. `lint` = prettier --check . + eslint . (the tasks/\*.md
    files are prettier-checked; run `npm run format` before committing).

## 3. New launcher spec: `scripts/run-dashboard.sh`

One file, self-contained (curl|bash safe), structured with the repo's
function-per-phase convention: `usage → parse_arguments → resolve_identity →
read_secrets → validate_options → prepare_registry|prepare_checkout →
prepare_arguments → run_registry|run_build`, one `main` at the end.

### Modes

- Registry (default): `docker pull <image>` then `exec docker run --rm …` in the
  foreground. Stable named volumes `dashboard_data:/data`,
  `ddash_zsh_data:/dashboard-history`. Ctrl+C stops the container; volumes persist.
- Build (`--build`): must run from a checkout (resolve repo root from
  `BASH_SOURCE`, require Dockerfile + git repo; actionable error otherwise).
  Buildx `--load` with revision/local-changes labels, unique test container name
  (default `ddash-local-<rev12>-<timestamp>-$$`), detached run, poll state +
  healthcheck until `--health-timeout` (default 180s), then in-container HTTP
  verification (GET `/healthz` → 200, GET `/api/containers` → 401). On any failure
  retain container + volumes and print inspection commands. Publication stays
  loopback-only in this mode.

### Shared flag grammar

| Flag                                            | Meaning                                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--workspace PATH`                              | bind source == target; per-mode default below                                                                                                                                        |
| `--socket PATH`                                 | Docker-host socket, default `/var/run/docker.sock`                                                                                                                                   |
| `--port N`                                      | published host port; registry default 3000, build default 3001                                                                                                                       |
| `--bind-address ADDR`                           | registry-mode publication address, default loopback (preserve the existing literal from the current script)                                                                          |
| `--origin URL`                                  | forwarded only when set (adapter-node rejects empty ORIGIN); validate as http(s) authority, no path/credentials/port-range violations — adopt `valid_origin` from the compose script |
| `--password VALUE`                              | explicit password (document `ps` exposure caveat in --help)                                                                                                                          |
| `--password-file PATH`                          | read password from file, trim one trailing newline, never echo                                                                                                                       |
| `--host-user/--host-uid/--host-gid/--host-home` | all-or-none identity override; same validation as today; otherwise resolve via passwd / `SUDO_USER`                                                                                  |
| `--bootstrap` / `--no-bootstrap`                | dev-bootstrap hook, default off; prints `dev-bootstrap: 0/1`                                                                                                                         |
| `--ssh-dir` / `--no-ssh-dir`                    | read-only `HOST_HOME/.ssh` bind, default off                                                                                                                                         |
| `--no-create-workspace`                         | skip local `mkdir -p` (remote daemons)                                                                                                                                               |
| `--non-interactive`                             | disable all prompts; requires password via flag/file                                                                                                                                 |
| `--gateway`                                     | sets `SERVICE_PROXY_ENABLED=1` passthrough                                                                                                                                           |
| `--gateway-host HOST`                           | `SERVICE_PROXY_HOST` passthrough                                                                                                                                                     |
| `--gateway-ports SPEC`                          | `SERVICE_PROXY_PORTS` passthrough                                                                                                                                                    |
| `--vscode-ssh-host VALUE`                       | `VSCODE_SSH_HOST` passthrough (was Compose-only)                                                                                                                                     |
| `--help`, `-h`                                  | full usage; needs no daemon/identity/password                                                                                                                                        |

Registry-only: `--image REF` (default `ghcr.io/axelthas/devcontainer-dashboard:latest`).
Build-only: `--platform VALUE`, `--name NAME`, `--health-timeout SECONDS`.
Mode violations (`--image` with `--build`, build flags in registry mode) fail with
clear errors.

### Kept ambient environment (documented deviations)

- `SSH_AUTH_SOCK`: forwarded read-only at its original absolute path when exported.
- `SUDO_USER`: used by passwd-based identity resolution under sudo.

Everything else (`DASHBOARD_PASSWORD`, `WORKSPACE_ROOT`, `DOCKER_SOCKET`,
`ORIGIN`/`DDASH_ORIGIN`, `DASHBOARD_IMAGE`, `DASHBOARD_BIND_ADDRESS`,
`DDASH_DEV_BOOTSTRAP`, `DDASH_SSH_DIRECTORY`, `DDASH_NONINTERACTIVE`,
`DDASH_CREATE_WORKSPACE`, `DASHBOARD_TEST_NAME`, `DASHBOARD_TEST_PORT`,
`DASHBOARD_HEALTH_TIMEOUT`, `DOCKER_DEFAULT_PLATFORM`, `HOST_*`,
`SERVICE_PROXY_*`) is no longer read by the launcher.

### Behavior notes

- Workspace defaults: registry mode `$HOST_HOME/ddash-workspace`, build mode
  `$HOST_HOME/ddash-production-workspace` (behavior change vs today: the direct
  installer no longer hard-requires `WORKSPACE_ROOT` when non-interactive; record
  this in the issue/PR).
- Bind sources must be absolute, comma/newline-free; same-path binds; `--mount`
  (not `-v`) so missing sources fail closed; SSH resources read-only.
- Print the plan lines as today (operator identity, bootstrap state, bind-source
  warning, retention notes in build mode).
- Password must never appear in stdout/stderr/argv of mocked calls (keep the
  non-disclosure tests).

## 4. Compose removal

- Delete `docker-compose.yml`, `scripts/run-dashboard-compose.sh`.
- Rewrite `scripts/tests/container-smoke.sh`:
  - Drop `check_compose_rendering` (launcher argv assembly is covered by the
    mocked launcher tests).
  - Start the fixture dashboard with plain `docker run -d` mirroring the
    launcher's argv: dynamic publication (`-p <loopback>::3000`), fixture hooks
    bound to `/docker-entrypoint.d` (read-only), read-only SSH dir bind, named
    volumes, `restart: no` semantics.
  - Replace `docker compose port dashboard 3000` with `docker port "$CID" 3000`
    (or inspect-based lookup); cleanup uses `docker rm -f` + `docker volume rm`
    for its unique names instead of `compose down -v`.
  - Remove the Compose 2.24.4+ requirement from the header/docs.
- Do NOT touch the compose-project grouping feature (`com.docker.compose.project`
  labels in `src/routes/+page.server.ts`, `src/routes/api/containers/+server.ts`,
  `src/lib/types.ts`).

## 5. Plugins relocation

- `git mv scripts/10-dev-bootstrap.sh plugins/10-dev-bootstrap.sh`
- `Dockerfile`: `COPY plugins/10-dev-bootstrap.sh /opt/dashboard/plugins/10-dev-bootstrap.sh`
  (and the chmod line).
- `docker-entrypoint.sh`: bundled-hook glob and error message
  `/opt/dashboard/hooks/…` → `/opt/dashboard/plugins/…`. Operator-supplied
  `/docker-entrypoint.d/` unchanged. `docker run image dev-bootstrap` unchanged.
- Update the `deployment.test.mjs` fixture path rewrite accordingly.
- Unrelated and untouched: `~/.devbootstrap` fallback + `src/lib/server/bootstrap.ts`,
  `bootstrap-providers.example.json`, `presets.example.json`.

## 6. Test changes

- Rename `scripts/tests/run-production.test.mjs` → `scripts/tests/run-dashboard.test.mjs`:
  - Shared cases once: identity flags + passwd fallback + `SUDO_USER` capture, the
    invalid-identity rejection matrix, password prompt/`--password`/
    `--password-file`, `--help` needs nothing, `--origin` validation, secret
    non-disclosure, bootstrap/ssh-dir/agent mounts, same-path binds,
    `--no-create-workspace`.
  - Registry mode: pull then foreground `docker run --rm` argv, image default,
    bind-address/port, hook selection.
  - Build mode: buildx argv (`--load`, labels, platform), unique name, loopback
    publication, health-timeout, gateway passthrough flags, blank-origin omitted,
    failure retention (no rm/stop/kill), readiness failure diagnostics.
  - Keep the curl-piped PTY test pattern (util-linux `script`) for prompts.
- `scripts/tests/deployment.test.mjs`: remove the Compose contract test; retire
  the three-way `resolve_identity` comparison (single script now); update the
  fixture rewrite for the plugins path.
- `scripts/tests/bootstrap-hook.test.mjs`: new script path.
- `package.json`: `test:deployment` list updated accordingly.

## 7. Docs

- `README.md`: new quick-start (curl line + common flags), remove both Compose
  paths and the Compose paragraph in Deployment; Tailscale section step 3 replaces
  `export ORIGIN=…` + `run-production.sh` with `--origin`; manual build/run
  procedure re-expressed with flags; env table row for `DASHBOARD_BIND_ADDRESS`
  now says launcher flag; document launcher flags near the run instructions.
- `scripts/README.md`: single launcher with two modes, flag grammar, plugins dir,
  remove the deliberate-duplication paragraph and compose sections.
- `HOST-IDENTITY.md`: replace the checked-in Compose sentence with identity flags.
- `ARCHITECTURE.md`: repo tree (`docker-compose.yml` removal, `plugins/`).
- `AGENTS.md`: env var table (`DASHBOARD_BIND_ADDRESS` row), testing section
  (container-smoke no longer needs Compose), scripts references.
- Historical `specification/` files: leave as-is.

## 8. Validation matrix (run from the host checkout)

```bash
npm run lint
npm run test:deployment
npm run check
npm run build && npm run build:server && npm run test:production
npm run test:unit -- --run
npm run test:gateway
bash scripts/tests/container-smoke.sh # needs non-root operator w/ /home home, Docker, Node 22, deps
```

Real-world (host, before merge):

```bash
# Build mode from the checkout
bash scripts/run-dashboard.sh --build --port 3001 \
	--non-interactive --password-file /path/to/pw --workspace /abs/host/path
# Registry mode, curl|bash form
curl -sL https://raw.githubusercontent.com/axelthas/devcontainer-dashboard/<branch>/scripts/run-dashboard.sh \
	| bash -s -- --non-interactive --password-file /path/to/pw --workspace /abs/host/path
```

Optional gateway live validation follows PR #22's operator steps (Tailscale +
`--gateway --origin …`).

## 9. Environment caveats

- REDACTED LITERALS: the devcontainer session's file views showed some bytes as
  bracketed placeholders (loopback bind address, a numeric UID bound constant, the
  GitLab SSH host in the bootstrap hook). Those tokens are NOT the file contents.
  When editing near such lines, take exact bytes from the actual files (e.g. via
  shell) and verify with `git diff` that no placeholder strings leaked in.
- `lint` prettier-checks all `.md`/`.mjs` — run `npm run format` before committing;
  this handoff file must be formatted too.
- The shell tests use plain `node:test` — every test needs assertions.
- CI runs only for PRs targeting `main`; until retargeting, rely on the local matrix.
- No `.github/` workflow changes are needed (publish.yml builds from `main`).

## 10. Suggested commit sequence

1. `refactor(plugins): move bootstrap hook to plugins/, container dir rename` —
   git mv, Dockerfile, entrypoint, deployment/bootstrap-hook test paths.
2. `feat(deploy): single args-driven launcher with registry and build modes` —
   rewrite `scripts/run-dashboard.sh`, rename/rewrite the launcher test file,
   update `package.json`.
3. `refactor(deploy): remove Compose variant, docker-run based container smoke` —
   delete compose files, rework `container-smoke.sh`, drop compose tests.
4. `docs: single-launcher deployment guide, plugins layout` — README, scripts/README,
   HOST-IDENTITY, ARCHITECTURE, AGENTS.md.
5. Validation fixups + continuation log updates in this handoff file.

## Continuation log

- 2026-11-04: plan agreed with the operator (see decision record); handoff saved
  in-repo as `tasks/simplify-deployment-handoff.md`. No code changes yet.
