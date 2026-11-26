// Exercise the production config-parent helper with disposable directories.
// Ownership and mount queries are mocked: these checks never chown host files.
// Run: node --test scripts/tests/entrypoint-config.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	existsSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const entrypoint = readFileSync(new URL('../../docker-entrypoint.sh', import.meta.url), 'utf8');
const helper = entrypoint.match(/^prepare_config_home\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(helper, 'Missing config-parent preparation helper');

// Run the actual shell helper with safe stand-ins for privileged operations.
function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), 'devharbour-config-parent-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const home = join(dir, 'operator home');
	const bin = join(dir, 'bin');
	const log = join(dir, 'ownership.log');
	mkdirSync(home);
	mkdirSync(bin);
	writeFileSync(join(bin, 'chown'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LOG"\n', {
		mode: 0o755
	});
	writeFileSync(join(bin, 'findmnt'), '#!/bin/sh\nprintf "%s\\n" "${CONFIG_MOUNT:-/}"\n', {
		mode: 0o755
	});
	return {
		dir,
		home,
		log,
		run(env = {}) {
			return spawnSync(
				'sh',
				['-eu', '-c', 'fail() { echo "$*" >&2; exit 1; }\n' + helper + '\nprepare_config_home\n'],
				{
					encoding: 'utf8',
					env: {
						...process.env,
						PATH: bin + ':' + process.env.PATH,
						HOST_HOME: home,
						HOST_UID: '2345',
						HOST_GID: '3456',
						LOG: log,
						...env
					}
				}
			);
		}
	};
}

test('creates a missing private config parent', (t) => {
	const f = fixture(t);
	const result = f.run();
	assert.equal(result.status, 0, result.stderr);
	assert.ok(existsSync(join(f.home, '.config')));
	assert.equal(readFileSync(f.log, 'utf8'), `-h -- 2345:3456 ${f.home}/.config\n`);
});

test('repairs only the parent of an existing nested Settings mount', (t) => {
	const f = fixture(t);
	const nested = join(f.home, '.config/devharbour');
	mkdirSync(nested, { recursive: true });
	writeFileSync(join(nested, 'config.json'), 'unchanged\n');
	for (let attempt = 0; attempt < 2; attempt++) {
		assert.equal(f.run().status, 0);
	}
	const lines = readFileSync(f.log, 'utf8').trim().split('\n');
	assert.deepEqual(lines, Array(2).fill(`-h -- 2345:3456 ${f.home}/.config`));
	assert.equal(readFileSync(join(nested, 'config.json'), 'utf8'), 'unchanged\n');
});

for (const broken of [false, true]) {
	test(`refuses a ${broken ? 'broken' : 'live'} config-parent symlink`, (t) => {
		const f = fixture(t);
		const target = join(f.dir, 'outside');
		if (!broken) mkdirSync(target);
		symlinkSync(target, join(f.home, '.config'));
		const result = f.run();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /must not be a symlink/);
		assert.equal(existsSync(f.log), false);
	});
}

test('refuses a regular file instead of a config parent', (t) => {
	const f = fixture(t);
	writeFileSync(join(f.home, '.config'), 'untouched');
	const result = f.run();
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /must be a directory/);
	assert.equal(existsSync(f.log), false);
});

test('refuses to change ownership of a mounted config parent', (t) => {
	const f = fixture(t);
	mkdirSync(join(f.home, '.config'));
	const result = f.run({ CONFIG_MOUNT: join(f.home, '.config') });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /must remain container-private/);
	assert.equal(existsSync(f.log), false);
});

test('prepares config ownership before privilege dropping', () => {
	const invocation = entrypoint.indexOf('\nprepare_config_home\n');
	assert.ok(invocation > entrypoint.indexOf(helper));
	assert.ok(invocation < entrypoint.indexOf('exec runuser'));
});
