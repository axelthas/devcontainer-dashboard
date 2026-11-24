// Test explicit dev-bootstrap installation and runtime PATH contracts in isolation.
// Use a disposable socket and mocked Git/installer. No keys, GitLab calls or real
// authentication are involved. Run: node --test scripts/tests/bootstrap-hook.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Prepare an isolated home, socket and provider installer with selectable failures. */
async function fixture(t) {
	const home = mkdtempSync(join(tmpdir(), 'ddash-bootstrap-'));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const socket = join(home, 'agent.sock');
	const server = createServer().listen(socket);
	await once(server, 'listening');
	t.after(() => server.close());
	const bin = join(home, 'bin');
	mkdirSync(bin);
	writeFileSync(
		join(bin, 'git'),
		`#!/bin/bash
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
`,
		{ mode: 0o755 }
	);
	return {
		home,
		/** Execute the hook without replacing its credential checks. */
		run(env = {}) {
			return spawnSync('bash', [join(root, 'plugins/tern-dev-bootstrap.sh')], {
				encoding: 'utf8',
				timeout: 5000,
				env: {
					...process.env,
					HOME: home,
					PATH: `${bin}:${process.env.PATH}`,
					SSH_AUTH_SOCK: socket,
					GIT_SSH_COMMAND: '',
					...env
				}
			});
		}
	};
}

test('explicit installation requires the agent instead of falling back to key files', async (t) => {
	const f = await fixture(t);
	mkdirSync(join(f.home, '.ssh'));
	writeFileSync(join(f.home, '.ssh/id_ed25519'), 'fake key data');
	const result = f.run({ SSH_AUTH_SOCK: '' });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /no SSH agent socket/);
});

test('clones and installs with strict host-key policy without modifying SSH files', async (t) => {
	const f = await fixture(t);
	mkdirSync(join(f.home, '.ssh'));
	writeFileSync(join(f.home, '.ssh/known_hosts'), '# trusted fixture\n');
	const result = f.run();
	assert.equal(result.status, 0, result.stderr);
	assert.match(readFileSync(join(f.home, 'ssh-policy'), 'utf8'), /StrictHostKeyChecking=yes/);
	assert.equal(readFileSync(join(f.home, '.ssh/known_hosts'), 'utf8'), '# trusted fixture\n');
	assert.match(result.stdout, /devbootstrap is available/);
	assert.equal(f.run().status, 0, 'existing installation can be rerun');
});

for (const [env, diagnostic] of [
	[{ FAIL_CLONE: '1' }, /Clone failed/],
	[{ FAIL_INSTALL: '1' }, /installer failed/],
	[{ NO_SHIM: '1' }, /not on PATH/]
]) {
	test(`bootstrap fails closed: ${JSON.stringify(env)}`, async (t) => {
		const f = await fixture(t);
		const result = f.run({ GIT_SSH_COMMAND: 'ssh -F /operator/config', ...env });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, diagnostic);
	});
}

test('broken existing installation reports repair instructions', async (t) => {
	const f = await fixture(t);
	mkdirSync(join(f.home, '.devbootstrap'));
	assert.match(f.run().stderr, /install.sh is missing/);
});

test('runtime PATH includes the bootstrap shim for server and terminal children', () => {
	const source = readFileSync(join(root, 'docker-entrypoint.sh'), 'utf8');
	assert.ok(source.includes('export PATH="/opt/dashboard-tools/bin:$HOME/.local/bin:$PATH"'));
});
