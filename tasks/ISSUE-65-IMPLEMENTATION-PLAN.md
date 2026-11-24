# Issue #65: Installable DevHarbour CLI

Status: implemented in draft PR #66. Disposable real-Docker acceptance is still required before merge.

Authoritative scope and acceptance criteria: [issue #65](https://github.com/axelthas/devcontainer-dashboard/issues/65).

## Baseline

This branch starts from main at `1a5d314089cc1fbd4ad1849e39d63aaaa15e9085`.
The existing execution entrypoint is `scripts/run-dashboard.sh`.
Reuse or refactor its Docker argument construction instead of creating a second
independent deployment implementation.

The original planning baseline predates the following work. The CLI branch is now stacked on PR #64 and includes its head `2e234f285e33769c64bec8cdb22af917be619660`:

- [Issue #63](https://github.com/axelthas/devcontainer-dashboard/issues/63) and
  [PR #64](https://github.com/axelthas/devcontainer-dashboard/pull/64): explicit
  host identity and SSH-agent socket, trusted known_hosts, and no private-key
  directory mounts.
- [PR #43](https://github.com/axelthas/devcontainer-dashboard/pull/43): detached
  startup and Docker restart policy.

The implementation uses the parent PR's explicit identity and SSH contract.
The managed restart default matches PR #43; direct launcher behavior is preserved.

## Intended operator contract

- Install a user-local `devharbour` command, normally in `~/.local/bin`.
- Keep installed support files outside temporary directories and the caller's
  working directory. Record their version or source ref.
- Support a downloaded installation and an installation from a checkout.
- Keep the published-image path independent of host Node.js and a source checkout.
- Without arguments, guide the first setup through validated settings to a ready
  instance. Later runs reuse the saved settings and instance.
- Explicit configuration arguments merge into the selected JSON file, persist,
  and then run. Omitted values preserve saved settings.
- `configure` edits configuration without launching. Provide explicit clearing
  and false operations for optional settings.
- Provide `status`, `logs`, `stop`, `--help`, and `--version`.
- Non-interactive execution never prompts. Missing required input fails before
  configuration writes or deployment.

Default configuration path:
`${XDG_CONFIG_HOME:-$HOME/.config}/devharbour/config.json`.
Allow `--config PATH`.

Precedence: explicit CLI values > saved JSON values > documented defaults.
Prompts fill unresolved settings and visibly confirm proposed host settings.
Do not infer a remote Docker host's identity from the machine running the CLI.

## Implementation sequence

### 1. Define the configuration contract

- [x] Select and document a JSON parser/runtime that preserves the no-host-Node
      published-image contract. Report missing dependencies; do not install host
      packages silently.
- [x] Define a versioned schema with typed deployment inputs and stable resource
      identifiers. Keep observed runtime state and last-applied configuration
      separate from desired configuration.
- [x] Map supported launcher arguments, mode restrictions, defaults, optional
      settings, and explicit clearing operations.
- [x] Define relative paths against the config directory. Distinguish CLI-local
      input files from Docker-host bind sources.
- [x] Reject malformed JSON, unknown keys, unsupported versions and invalid
      feature combinations. Never source or execute configuration content.
- [x] Use private directories (0700) and files (0600), atomic writes, and locking
      for concurrent updates. Preserve prior settings on cancellation or failed
      validation.

### 2. Add the CLI and guided setup

- [x] Separate argument parsing, configuration loading, prompting, validation,
      launch planning, execution and readiness checks.
- [x] Implement a short basic setup and an optional advanced section covering
      existing supported launcher features.
- [x] Show a redacted summary before first deployment. Require explicit opt-in
      for remote exposure and public Brain Funnel access.
- [x] Store credential file references, never secret values, in JSON. Protect
      wizard-created secret files and exclude values from output and argv.
- [x] Revalidate saved SSH-agent sockets and explain stale paths. Never start a
      replacement agent, alter socket permissions, or mount private-key folders.
- [x] Make help and version independent of Docker, credentials and config.

### 3. Reuse deployment execution and add managed lifecycle

- [x] Share the existing Docker argument construction and validations. Preserve
      direct launcher usage or document any deliberate migration.
- [x] Keep normal managed deployment separate from checkout-build/test instances.
      An installed command must use an explicit source-checkout path for builds.
- [x] Run the normal instance detached and coordinate restart-policy behavior
      with PR #43. Display the selected policy during setup.
- [x] Leave a healthy unchanged instance alone. Resume a stopped unchanged
      instance without creating another container or pulling another image.
- [x] Detect changes that require recreation. Show the change and obtain explicit
      approval. Non-interactive replacement requires a documented explicit option.
- [x] Refuse silent adoption or replacement of unrelated containers. Preserve
      existing data, history and AI-state volumes. Define explicit adoption.
- [x] Pull a missing selected image on initial launch. Do not implicitly refresh
      an existing image or upgrade the CLI during configuration changes.
- [x] Verify application readiness and Docker API access separately. Print the
      actual URL and management commands only with an accurate success status.
- [x] If launch fails after saving valid desired settings, report that distinction
      and leave last-applied state unchanged.

### 4. Package installation

- [x] Add the installer, proposed as `scripts/install-devharbour.sh`.
- [x] Support a custom installation directory without requiring sudo for a user
      installation.
- [x] Report missing PATH configuration without silently editing shell files.
- [x] Support safe reinstallation without overwriting config, credentials or
      runtime data. Refuse to overwrite an unrelated executable.

### 5. Validate and document

- [x] Add focused installer, JSON, CLI and lifecycle regressions using temporary
      fixtures and mocked Docker boundaries.
- [x] Cover precedence, explicit false/unset, config-only mode, no-terminal runs,
      permissions, cancellation, interrupted writes and concurrent edits.
- [x] Cover inaccessible Docker, invalid mounts, port conflicts, stale/empty/
      inaccessible agents, trusted host-key input, pull failures and timeouts.
- [ ] Test disposable real-Docker first launch, unchanged reuse, stopped-instance
      resume and explicitly approved recreation. Do not use operator data as a
      fixture or restart an operator's Docker daemon as a test.
- [x] Verify the production custom server, login and terminal WebSocket path,
      not only Vite preview or `/healthz`.
- [x] Update README and launcher references with installation, schema, precedence,
      secrets, unattended examples, lifecycle behavior and migration guidance.
- [x] Record exact tested revisions, commands and limitations before marking the
      implementation ready for review.

## Boundaries

No application feature changes, host permission changes, Docker/Tailscale
installation, private-key distribution, automatic CLI/image upgrades, automatic
Brain grants, or deletion of existing installation data.

Keep scripts organized around small documented named functions and one main
entrypoint. The original planning commit changed documentation only; the implementation
and validation status below supersedes that historical statement.

## Implementation and validation record

The original CLI at `d22fd15` used Python standard-library prompts. The current
menu-based redesign below supersedes that interaction and installer design.
`scripts/install-devharbour.sh` installs a pinned runtime plus a user-local wrapper.
The shared launcher adds validation-only and managed-registry paths without a
second Docker argument builder. `npm run test:cli` is also part of `npm test`.

Implemented safeguards include private atomic JSON writes, config locks, typed
settings, terminal-only hidden passwords, explicit optional-feature clearing,
field-level replacement review, ownership labels, retained-volume adoption checks,
and separate last-applied state. A reused instance rechecks application readiness,
Docker access and the operator's SSH agent. Readiness checks retain the operator's
supplementary groups with `runuser`, not a bare Docker UID:GID override.

Validation in the existing granted devcontainer (Node 22.23.5, Python 3.12.3):

- `npm run test:cli`: 48 passed, including real disposable PTY setup/cancellation,
  atomic-write failure, concurrent-lock rejection, installer download/archive mocks
  and mocked Docker lifecycle/failure cases.
- `npm run test:deployment`: 108 passed.
- `npm run test:ssh`: 39 passed.
- `npm run check`: no errors; two existing Svelte `state_referenced_locally`
  warnings in `src/routes/+page.svelte`.
- `npm run build` and `npm run build:server`: passed.
- `npm run test:production`: passed compiled-server login, upgrade authorization,
  explicit terminal-session creation and PTY output.
- Full `npm run lint`: passed on a plain staged/index export with the existing
  installed dependencies, excluding the operator's unrelated unstaged edits.
- Bash syntax and Python compilation/tabnanny: passed.

No CLI was installed into the operator's real bin directory. No existing Docker
container, image, volume, host package, credential or agent was changed. Installer
and Docker CLI tests use isolated fixtures. Docker is reachable, but this work has
not executed disposable native-host container acceptance, an actual remote archive
download, boot/restart acceptance or real end-to-end SSH forwarding. The compiled
server smoke does not establish those outcomes. Full application unit and E2E
suites were not rerun for this CLI-only implementation; the parent PR records its
own separate results and blockers.

PR #66 must remain draft until real-Docker first-run/reuse/replacement, compatible
image selection and the inherited SSH acceptance blockers are resolved. The
existing GitHub workflow targets main only and does not run the dedicated CLI
suite directly; `npm test` now includes it, but stacked-branch CI coverage still
needs the separate CI/release follow-up rather than a claim of green CI here.

## Menu-based redesign (current)

The operator rejected the raw questionnaire after testing. The interactive path is
now a dedicated `devharbour_ui.py` module using Questionary/prompt-toolkit, following
the installed devbootstrap reference: numbered steps, arrow menus, checkbox
features, Escape/back navigation, saved-setting reuse, and grouped review with
jump-to-step edits. The runtime/orchestration stays in `devharbour.py`.

Five editable steps cover source mode, host/workspace/SSH, access/login, optional
capabilities, and review. Step six applies a reviewed plan. Invalid plans expose
edit/cancel choices instead of save/start. `configure` is save-only. Explicit flags
are preserved, secrets stay hidden, and cancellation does not write partial JSON.

The installer keeps pinned menu dependencies in a private versioned Python venv
and retains a clean commit-pinned source checkout. A local build is now an image
source for the same managed instance, not the separate isolated build command.
`devharbour_source.py` verifies origin, cleanliness and revision, never resets a
modified checkout, builds before any container lifecycle change, checks cached
image provenance, and returns an immutable image ID. `--rebuild` is explicit.
Existing schema-1 JSON remains valid; optional source metadata is additive.

Regression coverage includes UI-controller navigation, real Questionary PTYs
(Enter/save, arrow-key jump, Escape/back and Ctrl+C cancellation), legacy config
migration, conditional port defaults, source/image provenance, local edits and
build-before-replacement. The native local-build path was also exercised with a
disposable scratch-image Git fixture, including revision labels and cached reuse;
that is not a production DevHarbour image or native-host acceptance test.

The older implementation/check results above are historical. Current exact
revision and final validation counts are recorded in the PR description. Native
production-image startup/replacement/reboot and end-to-end host GCR/Tailscale
acceptance remain separate draft blockers. Operator worktree edits are excluded.
