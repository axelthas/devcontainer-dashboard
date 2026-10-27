import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');

// All privileged commands are mocks. The socket and home are disposable.
async function fixture(t) {
	const dir = mkdtempSync(join(root, '.entrypoint-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const socket = join(dir, 'docker.sock');
	const listener = createServer().listen(socket);
	await once(listener, 'listening');
	t.after(() => listener.close());
	const bin = join(dir, 'bin');
	const home = join(dir, 'operator home');
	mkdirSync(bin);
	mkdirSync(home);
	for (const path of ['shell', 'bundled', 'hooks', 'sudoers']) mkdirSync(join(dir, path));
	for (const name of ['.zshrc', '.bashrc']) writeFileSync(join(dir, 'shell', name), '# template\n');
	const log = join(dir, 'commands');
	const mocks = {
		id: 'echo 0',
		stat: 'test "${FAIL_STAT:-}" != 1 && test "$1" = -Lc || exit 1; echo "${SOCKET_GID:-9876}"',
		findmnt: 'echo "${HOME_MOUNT:-/}"',
		getent: `case "$1:$2" in
passwd:operator|passwd:2345)
  case "\${ACCOUNT_MODE:-new}" in
    compatible) echo "operator:x:2345:3456::$HOST_HOME:/bin/zsh" ;;
    conflict) echo "other:x:2345:3456::/home/other:/bin/bash" ;;
  esac ;;
group:*) test "\${MISSING_GROUPS:-0}" != 1 || exit 2; echo "test-group:x:$2:" ;;
esac`,
		groupadd: 'echo "groupadd $*" >> "$LOG"; test "${FAIL_GROUPADD:-}" != 1',
		useradd: 'echo "useradd $*" >> "$LOG"; test "${FAIL_USERADD:-}" != 1',
		usermod: 'echo "usermod $*" >> "$LOG"; test "${FAIL_USERMOD:-}" != 1',
		chown: 'echo "chown $*" >> "$LOG"',
		chmod: 'echo "chmod $*" >> "$LOG"',
		runuser: `echo "drop $*" >> "$LOG"
shift 3
exec "$@"`,
		node: 'echo "server:$USER:$LOGNAME:$HOME:$HISTFILE"'
	};
	for (const [name, body] of Object.entries(mocks)) {
		writeFileSync(join(bin, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
	}
	const source = read('docker-entrypoint.sh')
		.replaceAll('/var/run/docker.sock', socket)
		.replaceAll('/opt/dashboard-shell', join(dir, 'shell'))
		.replaceAll('/opt/dashboard/hooks', join(dir, 'bundled'))
		.replaceAll('/docker-entrypoint.d', join(dir, 'hooks'))
		.replaceAll('/etc/sudoers.d', join(dir, 'sudoers'))
		.replaceAll('mkdir -p /data /dashboard-history', `mkdir -p "${dir}/data" "${dir}/history"`)
		.replaceAll('"$HOST_UID:$HOST_GID" /data /dashboard-history', `"$HOST_UID:$HOST_GID" "${dir}/data" "${dir}/history"`);
	const path = join(dir, 'entrypoint.sh');
	writeFileSync(path, source);
	return {
		dir,
		home,
		socket,
		log,
		run(env = {}, args = []) {
			return spawnSync('sh', [path, ...args], {
				encoding: 'utf8',
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					DASHBOARD_PASSWORD: 'fixture-password',
					HOST_USER: 'operator',
					HOST_UID: '2345',
					HOST_GID: '3456',
					HOST_HOME: home,
					LOG: log,
					...env
				}
			});
		}
	};
}

test('creates host-matched account and drops privileges before startup', async (t) => {
	const f = await fixture(t);
	const result = f.run();
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.stdout.includes(`server:operator:operator:${f.home}:/dashboard-history/.zsh_history`));
	const calls = readFileSync(f.log, 'utf8');
	assert.match(calls, /useradd --no-create-home --uid 2345 --gid 3456/);
	assert.match(calls, /usermod -aG test-group operator/);
	assert.match(calls, /drop -u operator -- \/bin\/sh -c/);
	assert.doesNotMatch(calls, /chown.*operator home.*\.ssh/);
	assert.doesNotMatch(calls, /chown.*-hR.*operator home/);
});

test('reuses a compatible account without changing its primary group', async (t) => {
	const f = await fixture(t);
	assert.equal(f.run({ ACCOUNT_MODE: 'compatible', SOCKET_GID: '3456' }).status, 0);
	assert.doesNotMatch(readFileSync(f.log, 'utf8'), /useradd|usermod -g /);
});

test('creates missing primary and supplementary groups', async (t) => {
	const f = await fixture(t);
	assert.equal(f.run({ MISSING_GROUPS: '1' }).status, 0);
	const calls = readFileSync(f.log, 'utf8');
	assert.match(calls, /groupadd --gid 3456 dashboard-3456/);
	assert.match(calls, /groupadd --gid 9876 docker-host-9876/);
});

for (const [name, env, diagnostic] of [
	['missing password', { DASHBOARD_PASSWORD: '' }, /DASHBOARD_PASSWORD/],
	['missing identity', { HOST_USER: '' }, /HOST_USER/],
	['root UID', { HOST_UID: '0' }, /Root UID/],
	['root GID', { HOST_GID: '0' }, /Root UID/],
	['invalid UID', { HOST_UID: '2;id' }, /numeric/],
	['invalid user', { HOST_USER: 'x;id' }, /HOST_USER/],
	['system home', { HOST_HOME: '/etc/operator' }, /non-system/],
	['relative home', { HOST_HOME: 'relative' }, /absolute/],
	['traversal home', { HOST_HOME: '/home/../etc' }, /non-system/],
	['conflicting account', { ACCOUNT_MODE: 'conflict' }, /another image account/],
	['whole home mount', { HOME_MOUNT: '/home' }, /Do not mount/],
	['stat failure', { FAIL_STAT: '1' }, /Cannot read the group ID/],
	['invalid socket GID', { SOCKET_GID: 'no' }, /Invalid group ID/],
	['group failure', { MISSING_GROUPS: '1', FAIL_GROUPADD: '1' }, /Cannot create/],
	['account failure', { FAIL_USERADD: '1' }, /Cannot create operator/],
	['membership failure', { FAIL_USERMOD: '1' }, /Cannot add operator/]
]) {
	test(`fails closed: ${name}`, async (t) => {
		const f = await fixture(t);
		const result = f.run(env);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, diagnostic);
		assert.doesNotMatch(result.stdout, /server:/);
	});
}

test('rejects a missing or regular-file Docker socket', async (t) => {
	const f = await fixture(t);
	rmSync(f.socket);
	for (const regular of [false, true]) {
		if (regular) writeFileSync(f.socket, '');
		const result = f.run();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /missing or is not a Unix socket/);
	}
});

test('hooks run after privilege dropping and preserve existing shell files', async (t) => {
	const f = await fixture(t);
	writeFileSync(join(f.home, '.zshrc'), 'operator-config\n');
	writeFileSync(join(f.dir, 'bundled/10-example.sh'), '#!/bin/sh\necho "bundled:$USER" >> "$LOG"\n', { mode: 0o755 });
	writeFileSync(join(f.dir, 'hooks/10-example.sh'), '#!/bin/sh\necho "operator:$USER" >> "$LOG"\n', { mode: 0o755 });
	writeFileSync(join(f.dir, 'hooks/20-disabled.sh'), 'exit 99\n');
	assert.equal(f.run({}, ['example']).status, 0);
	const calls = readFileSync(f.log, 'utf8');
	assert.ok(calls.indexOf('drop -u') < calls.indexOf('bundled:operator'));
	assert.ok(calls.indexOf('bundled:operator') < calls.indexOf('operator:operator'));
	assert.equal(readFileSync(join(f.home, '.zshrc'), 'utf8'), 'operator-config\n');
	assert.notEqual(f.run({}, ['unknown']).status, 0);
});

test('standalone launchers share one identity contract', () => {
	const scripts = ['run-production.sh', 'run-dashboard.sh', 'run-dashboard-compose.sh'].map((name) =>
		read(`scripts/${name}`).match(/resolve_identity\(\) \{[\s\S]*?\n\}/)[0]
	);
	assert.equal(scripts[0], scripts[1]);
	assert.equal(scripts[1], scripts[2]);
});

test('Compose uses explicit identity, strict bind sources and stable history volume', () => {
	const compose = read('docker-compose.yml');
	for (const key of ['HOST_USER', 'HOST_UID', 'HOST_GID', 'HOST_HOME']) {
		assert.ok(compose.includes(`${key}: \${${key}:?`));
	}
	assert.match(compose, /create_host_path: false/);
	assert.match(compose, /ddash_zsh_data:\/dashboard-history/);
	assert.doesNotMatch(compose, /\/home\/ddash/);
	assert.match(read('Dockerfile'), /NPM_CONFIG_PREFIX=\/opt\/dashboard-tools/);
	assert.match(read('Dockerfile'), /HEALTHCHECK[\s\S]*\/healthz/);
});
