import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
	chmodSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('entrypoint resolves a symlinked socket with dereferencing stat', async (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'ddash-socket-link-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const target = join(dir, 'host.sock');
	const socket = join(dir, 'docker.sock');
	const server = createServer();
	server.listen(target);
	await once(server, 'listening');
	t.after(() => server.close());
	chmodSync(target, 0o660);
	symlinkSync(target, socket);
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const stat = spawnSync('sh', ['-c', 'command -v stat'], { encoding: 'utf8' }).stdout.trim();
	assert.ok(stat);
	// Preserve real stat behavior but require dereferencing. The guard makes
	// this regression detectable even when the test user owns both objects.
	const mocks = {
		stat: `test "$1" = "-Lc" || exit 91\nexec "$REAL_STAT" "$@"`,
		getent: 'echo "socket-group:x:1234:"',
		sudo: 'exit 0',
		sg: `case "$3" in
test*) test -r "$TEST_SOCKET" && test -w "$TEST_SOCKET" ;;
'exec node build/server.js') echo server-started ;;
*) exit 92 ;;
esac`
	};
	for (const [name, body] of Object.entries(mocks)) {
		writeFileSync(join(bin, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
	}
	const source = readFileSync(new URL('../../docker-entrypoint.sh', import.meta.url), 'utf8')
		.replaceAll('/var/run/docker.sock', socket)
		.replaceAll('/docker-entrypoint.d', join(dir, 'hooks'));
	const entrypoint = join(dir, 'entrypoint.sh');
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		DASHBOARD_PASSWORD: 'fixture-password',
		REAL_STAT: stat,
		TEST_SOCKET: socket
	};
	writeFileSync(entrypoint, source);
	const fixed = spawnSync('sh', [entrypoint], { env, encoding: 'utf8' });
	assert.equal(fixed.status, 0, fixed.stderr);
	assert.match(fixed.stdout, /server-started/);
	writeFileSync(entrypoint, source.replace("stat -Lc '%g'", "stat -c '%g'"));
	const original = spawnSync('sh', [entrypoint], { env, encoding: 'utf8' });
	assert.notEqual(original.status, 0);
	assert.match(original.stderr, /Cannot read the group ID/);
});
