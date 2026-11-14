/** Exercise the actual state script against disposable paths and a mocked mount boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** Relocate only fixed filesystem roots; use real bash, flock, symlinks and exec. */
async function fixture() {
	const temp = await mkdtemp(join(tmpdir(), 'ddash-ai-state-'));
	const state = join(temp, 'state');
	const home = join(temp, 'home');
	const bin = join(temp, 'bin');
	const seed = join(temp, 'seed');
	await Promise.all([state, home, bin].map((path) => mkdir(path)));
	await writeFile(seed, '#!/bin/sh\nprintf "2.3.0\\n"\n', { mode: 0o700 });
	await writeFile(join(bin, 'findmnt'), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_STATE"\n', { mode: 0o700 });
	const source = await readFile(new URL('../ai-state.sh', import.meta.url), 'utf8');
	const script = join(temp, 'state.sh');
	await writeFile(script, source.replaceAll('/dashboard-ai', state).replace('/opt/dashboard-ai/opencode', seed)
		// The first replacement also touches the seed path, so replace that spelling.
		.replace(`/opt${state}/opencode`, seed));
	const env = { ...process.env, HOME: home, FIXTURE_STATE: state, PATH: `${bin}:${process.env.PATH}` };
	return { temp, state, home, script, env };
}

test('state and credentials survive home recreation, and the v2 binary is retained', async () => {
	const f = await fixture();
	try {
		const first = spawnSync('bash', [f.script, 'sh', '-c',
			'printf conversation > "$OPENCODE_DB"; printf setting > "$XDG_CONFIG_HOME/opencode/test"; printf "%s" "$OPENCODE_PASSWORD"'],
		{ env: f.env, encoding: 'utf8' });
		assert.equal(first.status, 0, first.stderr);
		assert.equal(first.stdout.length, 43);
		await rm(f.home, { recursive: true });
		await mkdir(f.home);
		const second = spawnSync('bash', [f.script, 'sh', '-c',
			'cat "$OPENCODE_DB"; printf ":"; cat "$XDG_CONFIG_HOME/opencode/test"; printf ":%s" "$OPENCODE_PASSWORD"'],
		{ env: f.env, encoding: 'utf8' });
		assert.equal(second.status, 0, second.stderr);
		assert.equal(second.stdout, `conversation:setting:${first.stdout}`);
		assert.equal((await stat(join(f.state, 'service-password'))).mode & 0o777, 0o600);
	} finally { await rm(f.temp, { recursive: true, force: true }); }
});

test('a second live dashboard cannot use the same volume, and exit releases its lock', async () => {
	const f = await fixture();
	let child;
	try {
		child = spawn('bash', [f.script, 'sh', '-c', 'printf ready; read ignored'], { env: f.env });
		await new Promise((resolve, reject) => {
			child.stdout.once('data', resolve);
			child.once('error', reject);
			child.once('exit', (code) => reject(new Error(`Premature exit: ${code}`)));
		});
		const second = spawnSync('bash', [f.script, 'true'], { env: f.env, encoding: 'utf8' });
		assert.notEqual(second.status, 0);
		assert.match(second.stderr, /Another dashboard/);
		child.stdin.end('done\n');
		await new Promise((resolve) => child.once('exit', resolve));
		const third = spawnSync('bash', [f.script, 'true'], { env: f.env, encoding: 'utf8' });
		assert.equal(third.status, 0, third.stderr);
	} finally {
		child?.kill();
		await rm(f.temp, { recursive: true, force: true });
	}
});

test('existing home state is not overwritten or deleted during setup', async () => {
	const f = await fixture();
	try {
		await mkdir(join(f.home, '.opencode'));
		await writeFile(join(f.home, '.opencode', 'keep'), 'old session');
		const result = spawnSync('bash', [f.script, 'true'], { env: f.env, encoding: 'utf8' });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /migrate it explicitly/);
		assert.equal(await readFile(join(f.home, '.opencode', 'keep'), 'utf8'), 'old session');
	} finally { await rm(f.temp, { recursive: true, force: true }); }
});
