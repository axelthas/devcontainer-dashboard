import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');

// Mock privileged commands, not the script's control flow. A real Unix socket
// exercises -S. Never modify the real Docker socket, groups, or /data.
async function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), 'ddash-entrypoint-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const socketPath = join(dir, 'docker.sock');
	const listener = createServer();
	listener.listen(socketPath);
	await once(listener, 'listening');
	t.after(() => listener.close());
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const log = join(dir, 'commands');
	const mocks = {
		stat: 'test "${FAIL_STAT:-}" != 1 || exit 1; echo "${GID:-1234}"',
		getent:
			'test "${GROUP_MISSING:-}" != 1 || test -f "$GROUP_CREATED" || exit 2; echo "socket-group:x:1234:"',
		sudo: `echo "sudo $*" >> "$LOG"
case "$1" in
groupadd) test "\${FAIL_GROUPADD:-}" != 1 || exit 1; touch "$GROUP_CREATED" ;;
usermod) test "\${FAIL_USERMOD:-}" != 1 || exit 1 ;;
esac`,
		sg: `echo "sg $*" >> "$LOG"
case "$3" in
test*) test "\${FAIL_ACCESS:-}" != 1 ;;
'exec node build/server.js') echo server-started ;;
*) exit 90 ;;
esac`
	};
	for (const [name, body] of Object.entries(mocks)) {
		writeFileSync(join(bin, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
	}
	const source = read('docker-entrypoint.sh')
		.replaceAll('/var/run/docker.sock', socketPath)
		.replaceAll('/opt/dashboard/hooks', join(dir, 'bundled'))
		.replaceAll('/docker-entrypoint.d', join(dir, 'operator-hooks'));
	const entrypoint = join(dir, 'entrypoint.sh');
	writeFileSync(entrypoint, source);
	return {
		dir,
		socketPath,
		log,
		run(env = {}, args = []) {
			return spawnSync('/bin/sh', [entrypoint, ...args], {
				encoding: 'utf8',
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					DASHBOARD_PASSWORD: 'fixture-password',
					LOG: log,
					GROUP_CREATED: join(dir, 'group-created'),
					...env
				}
			});
		}
	};
}

test('starts without a hook argument using the configured socket and custom server', async (t) => {
	const f = await fixture(t);
	const result = f.run();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /server-started/);
	assert.match(readFileSync(f.log, 'utf8'), /sg socket-group -c exec node build\/server.js/);
	assert.doesNotMatch(read('docker-entrypoint.sh'), /docker-host\.sock/);
});

test('creates a missing socket group', async (t) => {
	const f = await fixture(t);
	assert.equal(f.run({ GROUP_MISSING: '1' }).status, 0);
	assert.match(readFileSync(f.log, 'utf8'), /sudo groupadd --gid 1234 docker-host/);
});

for (const [name, env, diagnostic] of [
	['missing password', { DASHBOARD_PASSWORD: '' }, /DASHBOARD_PASSWORD/],
	['stat failure', { FAIL_STAT: '1' }, /Cannot read the group ID/],
	['invalid GID', { GID: 'invalid' }, /Invalid group ID/],
	['group creation failure', { GROUP_MISSING: '1', FAIL_GROUPADD: '1' }, /Cannot create/],
	['group membership failure', { FAIL_USERMOD: '1' }, /Cannot add ddash/],
	['inaccessible socket', { FAIL_ACCESS: '1' }, /not readable and writable/]
]) {
	test(`fails closed with a diagnostic: ${name}`, async (t) => {
		const f = await fixture(t);
		const result = f.run(env);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, diagnostic);
		assert.doesNotMatch(result.stdout, /server-started/);
	});
}

test('rejects a missing or non-socket mount', async (t) => {
	const f = await fixture(t);
	rmSync(f.socketPath);
	for (const regularFile of [false, true]) {
		if (regularFile) writeFileSync(f.socketPath, '');
		const result = f.run();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /missing or is not a Unix socket/);
	}
});

test('runs bundled and executable operator hooks in order, skipping other files', async (t) => {
	const f = await fixture(t);
	for (const path of ['bundled', 'operator-hooks']) mkdirSync(join(f.dir, path));
	writeFileSync(join(f.dir, 'bundled/10-example.sh'), '#!/bin/sh\necho bundled\n', {
		mode: 0o755
	});
	writeFileSync(join(f.dir, 'operator-hooks/10-example.sh'), '#!/bin/sh\necho operator\n', {
		mode: 0o755
	});
	writeFileSync(join(f.dir, 'operator-hooks/20-disabled.sh'), 'exit 99\n');
	const result = f.run({}, ['example']);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /bundled\n[\s\S]*operator\n[\s\S]*server-started/);
	assert.notEqual(f.run({}, ['unknown']).status, 0);
});

test('an empty operator hook directory does not terminate startup', async (t) => {
	const f = await fixture(t);
	mkdirSync(join(f.dir, 'operator-hooks'));
	assert.equal(f.run().status, 0);
});

test('production and Playwright commands use the same custom entry point', () => {
	const pkg = JSON.parse(read('package.json'));
	assert.equal(pkg.scripts.start, 'node build/server.js');
	assert.match(read('playwright.config.ts'), /npm run build:server && npm start/);
	assert.match(read('playwright.config.ts'), /PORT: '4173'/);
	assert.match(read('Dockerfile'), /HEALTHCHECK[\s\S]*\/healthz/);
});

test('all port publication paths default to loopback with an explicit override', () => {
	for (const path of [
		'docker-compose.yml',
		'scripts/run-dashboard-compose.sh',
		'scripts/run-dashboard.sh'
	]) {
		assert.ok(read(path).includes('${DASHBOARD_BIND_ADDRESS:-127.0.0.1}:3000:3000'), path);
	}
});

test('installer generates parameterized Compose without leaking its password', (t) => {
	if (process.platform !== 'linux') {
		t.skip('requires util-linux script for /dev/tty prompts');
		return;
	}
	const dir = mkdtempSync(join(tmpdir(), 'ddash-installer-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	const result = spawnSync(
		'script',
		['-q', '-e', '-c', 'bash scripts/run-dashboard-compose.sh', '/dev/null'],
		{
			cwd: root,
			input: `${dir}/workspace\n\nn\n`,
			encoding: 'utf8',
			timeout: 10000,
			env: {
				...process.env,
				HOME: dir,
				PATH: `${bin}:${process.env.PATH}`,
				DASHBOARD_PASSWORD: 'installer-secret-must-not-leak',
				DDASH_ORIGIN: ''
			}
		}
	);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const generated = readFileSync(
		join(dir, '.config/devcontainer-dashboard/docker-compose.yml'),
		'utf8'
	);
	assert.ok(generated.includes('${DASHBOARD_BIND_ADDRESS:-127.0.0.1}:3000:3000'));
	assert.ok(generated.includes('${DASHBOARD_PASSWORD:?DASHBOARD_PASSWORD must be set}'));
	assert.ok(generated.includes('/var/run/docker.sock:/var/run/docker.sock'));
	assert.doesNotMatch(generated, /installer-secret-must-not-leak/);
});

for (const [name, defaultOrigin, answer, expected] of [
	['local HTTP', '', '', ''],
	['environment default', 'https://dashboard.example.ts.net', '', 'https://dashboard.example.ts.net'],
	['prompt override', 'https://old.example.ts.net', 'https://new.example.ts.net/', 'https://new.example.ts.net'],
	['explicit port', '', 'https://dashboard.example.ts.net:8443', 'https://dashboard.example.ts.net:8443'],
	['IPv6 loopback', '', 'http://[::1]:3000', 'http://[::1]:3000'],
	['invalid path retry', '', 'https://example.com/path\nhttps://example.com', 'https://example.com'],
	['invalid port retry', '', 'https://example.com:65536\nhttps://example.com', 'https://example.com'],
	['interpolation retry', '', 'https://${SECRET}\nhttps://example.com', 'https://example.com']
]) {
	test(`curl-piped installer persists origin: ${name}`, (t) => {
		if (process.platform !== 'linux') {
			t.skip('requires util-linux script');
			return;
		}
		const dir = mkdtempSync(join(tmpdir(), 'ddash-origin-'));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const bin = join(dir, 'bin');
		mkdirSync(bin);
		writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
		const result = spawnSync(
			'script',
			['-q', '-e', '-c', 'cat scripts/run-dashboard-compose.sh | bash', '/dev/null'],
			{
				cwd: root,
				input: `${dir}/workspace\n${answer}\nn\n`,
				encoding: 'utf8',
				timeout: 10000,
				env: {
					...process.env,
					HOME: dir,
					PATH: `${bin}:${process.env.PATH}`,
					DASHBOARD_PASSWORD: 'fixture-password',
					DDASH_ORIGIN: defaultOrigin
				}
			}
		);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const generated = readFileSync(
			join(dir, '.config/devcontainer-dashboard/docker-compose.yml'),
			'utf8'
		);
		assert.ok(generated.includes(`ORIGIN: '${expected}'`));
		assert.ok(generated.includes('${DASHBOARD_BIND_ADDRESS:-127.0.0.1}:3000:3000'));
		assert.doesNotMatch(generated, /fixture-password/);
		if (expected) assert.ok(result.stdout.includes(`Dashboard address: ${expected}`));
	});
}
