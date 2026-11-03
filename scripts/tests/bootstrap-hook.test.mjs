// Test explicit dev-bootstrap installation and runtime PATH contracts in isolation.
//
// Usage: node --test scripts/tests/bootstrap-hook.test.mjs (Node 22 and Bash).
// Use temporary HOME directories and a mocked Git/installer to exercise missing
// credentials, installation failures, shim verification and strict SSH defaults.
// Read the entrypoint to assert its PATH contract. Do not use real keys, contact
// GitLab or install provider dependencies. Per-test cleanup removes fixture files.
// These tests do not prove actual SSH authentication or provider discovery at runtime;
// the disposable container fixture supplies separate integration coverage.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Create a temporary runtime HOME and mocked Git/installer with selectable failure modes.
// Return a hook runner and register cleanup; no network or real credentials are used.
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'ddash-bootstrap-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/bash
printf '%s\\n' "$GIT_SSH_COMMAND" > "$HOME/ssh-policy"
[[ "\${FAIL_CLONE:-0}" != 1 ]] || exit 1
mkdir -p "$HOME/.devbootstrap"
cat > "$HOME/.devbootstrap/install.sh" <<'INSTALL'
#!/bin/bash
[[ "\${FAIL_INSTALL:-0}" != 1 ]] || exit 1
[[ "\${NO_SHIM:-0}" != 1 ]] || exit 0
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\nexit 0\\n' > "$HOME/.local/bin/devbootstrap"
chmod +x "$HOME/.local/bin/devbootstrap"
INSTALL
chmod +x "$HOME/.devbootstrap/install.sh"
`, { mode: 0o755 });
  return {
    home,
    // Execute the fixture copy with per-test overrides; return captured output/status (and recorded calls).
    run(env = {}) {
      return spawnSync('bash', [join(root, 'scripts/10-dev-bootstrap.sh')], {
        encoding: 'utf8', timeout: 5000,
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, SSH_AUTH_SOCK: '', GIT_SSH_COMMAND: '', ...env }
      });
    }
  };
}
test('explicit installation fails instead of silently skipping without credentials', (t) => {
  const f = fixture(t);
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Installation was enabled.*no SSH/);
});
test('clones and installs with strict known-host policy without modifying SSH files', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, '.ssh'));
  writeFileSync(join(f.home, '.ssh/config'), '# operator configuration\n');
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(f.home, 'ssh-policy'), 'utf8'), /StrictHostKeyChecking=yes/);
  assert.equal(readFileSync(join(f.home, '.ssh/config'), 'utf8'), '# operator configuration\n');
  assert.match(r.stdout, /devbootstrap is available/);
  assert.equal(f.run().status, 0, 'existing installation can be rerun');
});
for (const [env, diagnostic] of [
  [{ FAIL_CLONE: '1' }, /Clone failed/],
  [{ FAIL_INSTALL: '1' }, /installer failed/],
  [{ NO_SHIM: '1' }, /not on PATH/]
]) {
  test(`bootstrap fails closed: ${JSON.stringify(env)}`, (t) => {
    const f = fixture(t);
    const r = f.run({ GIT_SSH_COMMAND: 'ssh -F /operator/config', ...env });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, diagnostic);
  });
}
test('broken existing installation reports repair instructions', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, '.devbootstrap'));
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /install.sh is missing/);
});
test('runtime PATH includes the bootstrap shim for server and terminal children', () => {
  const source = readFileSync(join(root, 'docker-entrypoint.sh'), 'utf8');
  assert.ok(source.includes('export PATH="/opt/dashboard-tools/bin:$HOME/.local/bin:$PATH"'));
});
