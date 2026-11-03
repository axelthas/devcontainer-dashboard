// Check Docker socket GID lookup through a symlink without touching Docker.
//
// Usage: node --test scripts/tests/socket-symlink.test.mjs (POSIX Node 22 and stat).
// Create a disposable Unix socket and symlink. Assert that the entrypoint selects
// dereferencing stat, then check the real stat result against the test process GID.
// No daemon is required and no host socket is changed. Cleanup closes the listener
// and removes only temporary fixture files. This narrow test does not exercise the
// entrypoint's account setup, access checks or production server startup.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('entrypoint uses dereferencing stat for a symlinked Docker socket', async (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'ddash-socket-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const target = join(dir, 'target.sock');
	const link = join(dir, 'docker.sock');
	const server = createServer().listen(target);
	await once(server, 'listening');
	t.after(() => server.close());
	symlinkSync(target, link);
	const source = readFileSync(new URL('../../docker-entrypoint.sh', import.meta.url), 'utf8');
	assert.match(source, /DOCKER_GID=\$\(stat -Lc '%g' "\$DOCKER_SOCKET"\)/);
	const result = spawnSync('stat', ['-Lc', '%g', link], { encoding: 'utf8' });
	assert.equal(result.status, 0);
	assert.equal(Number(result.stdout.trim()), process.getgid());
});
