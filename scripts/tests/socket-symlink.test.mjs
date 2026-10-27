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
