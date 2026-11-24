# Issue #65: Installable DevHarbour CLI

Status: planning only. No CLI or installer is implemented by this commit.

Authoritative scope and acceptance criteria: [issue #65](https://github.com/axelthas/devcontainer-dashboard/issues/65).

## Baseline

This branch starts from main at `1a5d314089cc1fbd4ad1849e39d63aaaa15e9085`.
The existing execution entrypoint is `scripts/run-dashboard.sh`.
Reuse or refactor its Docker argument construction instead of creating a second
independent deployment implementation.

Related work is not merged into this planning baseline:

- [Issue #63](https://github.com/axelthas/devcontainer-dashboard/issues/63) and
  [PR #64](https://github.com/axelthas/devcontainer-dashboard/pull/64): explicit
  host identity and SSH-agent socket, trusted known_hosts, and no private-key
  directory mounts.
- [PR #43](https://github.com/axelthas/devcontainer-dashboard/pull/43): detached
  startup and Docker restart policy.

Recheck these changes before implementation and coordinate their contracts.
Do not copy the baseline's implicit identity and SSH behavior into the new CLI.

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

- [ ] Select and document a JSON parser/runtime that preserves the no-host-Node
      published-image contract. Report missing dependencies; do not install host
      packages silently.
- [ ] Define a versioned schema with typed deployment inputs and stable resource
      identifiers. Keep observed runtime state and last-applied configuration
      separate from desired configuration.
- [ ] Map supported launcher arguments, mode restrictions, defaults, optional
      settings, and explicit clearing operations.
- [ ] Define relative paths against the config directory. Distinguish CLI-local
      input files from Docker-host bind sources.
- [ ] Reject malformed JSON, unknown keys, unsupported versions and invalid
      feature combinations. Never source or execute configuration content.
- [ ] Use private directories (0700) and files (0600), atomic writes, and locking
      for concurrent updates. Preserve prior settings on cancellation or failed
      validation.

### 2. Add the CLI and guided setup

- [ ] Separate argument parsing, configuration loading, prompting, validation,
      launch planning, execution and readiness checks.
- [ ] Implement a short basic setup and an optional advanced section covering
      existing supported launcher features.
- [ ] Show a redacted summary before first deployment. Require explicit opt-in
      for remote exposure and public Brain Funnel access.
- [ ] Store credential file references, never secret values, in JSON. Protect
      wizard-created secret files and exclude values from output and argv.
- [ ] Revalidate saved SSH-agent sockets and explain stale paths. Never start a
      replacement agent, alter socket permissions, or mount private-key folders.
- [ ] Make help and version independent of Docker, credentials and config.

### 3. Reuse deployment execution and add managed lifecycle

- [ ] Share the existing Docker argument construction and validations. Preserve
      direct launcher usage or document any deliberate migration.
- [ ] Keep normal managed deployment separate from checkout-build/test instances.
      An installed command must use an explicit source-checkout path for builds.
- [ ] Run the normal instance detached and coordinate restart-policy behavior
      with PR #43. Display the selected policy during setup.
- [ ] Leave a healthy unchanged instance alone. Resume a stopped unchanged
      instance without creating another container or pulling another image.
- [ ] Detect changes that require recreation. Show the change and obtain explicit
      approval. Non-interactive replacement requires a documented explicit option.
- [ ] Refuse silent adoption or replacement of unrelated containers. Preserve
      existing data, history and AI-state volumes. Define explicit adoption.
- [ ] Pull a missing selected image on initial launch. Do not implicitly refresh
      an existing image or upgrade the CLI during configuration changes.
- [ ] Verify application readiness and Docker API access separately. Print the
      actual URL and management commands only with an accurate success status.
- [ ] If launch fails after saving valid desired settings, report that distinction
      and leave last-applied state unchanged.

### 4. Package installation

- [ ] Add the installer, proposed as `scripts/install-devharbour.sh`.
- [ ] Support a custom installation directory without requiring sudo for a user
      installation.
- [ ] Report missing PATH configuration without silently editing shell files.
- [ ] Support safe reinstallation without overwriting config, credentials or
      runtime data. Refuse to overwrite an unrelated executable.

### 5. Validate and document

- [ ] Add focused installer, JSON, CLI and lifecycle regressions using temporary
      fixtures and mocked Docker boundaries.
- [ ] Cover precedence, explicit false/unset, config-only mode, no-terminal runs,
      permissions, cancellation, interrupted writes and concurrent edits.
- [ ] Cover inaccessible Docker, invalid mounts, port conflicts, stale/empty/
      inaccessible agents, trusted host-key input, pull failures and timeouts.
- [ ] Test disposable real-Docker first launch, unchanged reuse, stopped-instance
      resume and explicitly approved recreation. Do not use operator data as a
      fixture or restart an operator's Docker daemon as a test.
- [ ] Verify the production custom server, login and terminal WebSocket path,
      not only Vite preview or `/healthz`.
- [ ] Update README and launcher references with installation, schema, precedence,
      secrets, unattended examples, lifecycle behavior and migration guidance.
- [ ] Record exact tested revisions, commands and limitations before marking the
      implementation ready for review.

## Boundaries

No application feature changes, host permission changes, Docker/Tailscale
installation, private-key distribution, automatic CLI/image upgrades, automatic
Brain grants, or deletion of existing installation data.

Keep scripts organized around small documented named functions and one main
entrypoint. This planning commit changes documentation only; no build, test,
installation, deployment or runtime verification is claimed.
