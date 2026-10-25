import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../run-production.sh', import.meta.url));

function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), 'ddash-runner-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const log = join(dir, 'calls.jsonl');
	writeFileSync(
		join(bin, 'git'),
		`#!/bin/sh
case "$*" in
*--show-toplevel*) printf '%s\\n' "$FIXTURE_ROOT" ;;
*--porcelain*) printf '%s' "\${DIRTY_OUTPUT:-}" ;;
*symbolic-ref*) test "\${DETACHED:-}" != 1 || exit 1; echo feature/current-branch ;;
*) echo abcdef1234567890 ;;
esac
`,
		{ mode: 0o755 }
	);
	// Use Node only in the test double to preserve exact argv boundaries.
	writeFileSync(
		join(bin, 'docker'),
		`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'container') process.exit(process.env.EXISTING === '1' ? 0 : 1);
if (args[0] === 'buildx' && args[1] === 'build' && process.env.FAIL_BUILD === '1') process.exit(2);
if (args[0] === 'exec' && process.env.FAIL_HTTP === '1') process.exit(3);
if (args[0] === 'inspect') {
  if (args[2].includes('Health')) console.log(process.env.HEALTH || 'healthy');
  else console.log(process.env.STATE || 'running');
}
`,
		{ mode: 0o755 }
	);
	writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
	return {
		dir,
		run(args = [], env = {}) {
			const result = spawnSync('bash', [script, ...args], {
				cwd: tmpdir(),
				encoding: 'utf8',
				timeout: 10000,
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					FIXTURE_ROOT: dir,
					CALL_LOG: log,
					DASHBOARD_PASSWORD: 'do-not-log-this',
					DASHBOARD_TEST_NAME: 'ddash-test',
					DASHBOARD_TEST_PORT: '3001',
					DASHBOARD_HEALTH_TIMEOUT: '2',
					DOCKER_DEFAULT_PLATFORM: '',
					ORIGIN: '',
					DOCKER_SOCKET: '/host/docker.sock',
					WORKSPACE_ROOT: join(dir, 'workspace with spaces'),
					...env
				}
			});
			const calls = readFileSync(log, { encoding: 'utf8', flag: 'a+' })
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			return { ...result, calls };
		}
	};
}

test('builds the current working tree and runs the final image without npm or publishing', (t) => {
	const f = fixture(t);
	const result = f.run([], { DIRTY_OUTPUT: ' M src/server.ts' });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /feature\/current-branch.*local changes: true/);
	assert.match(result.stdout, /Ready: http:\/\/127.0.0.1:3001/);
	const build = result.calls.find((args) => args[0] === 'buildx' && args[1] === 'build');
	assert.ok(build.includes('--load'));
	assert.equal(build.at(-1), '.');
	assert.ok(build.includes('devcontainer-dashboard:ddash-test'));
	assert.ok(!build.includes('--push'));
	const run = result.calls.find((args) => args[0] === 'run');
	assert.ok(run.includes('127.0.0.1:3001:3000'));
	assert.ok(run.includes(`type=bind,source=${f.dir}/workspace with spaces,target=${f.dir}/workspace with spaces`));
	assert.ok(run.includes('type=bind,source=/host/docker.sock,target=/var/run/docker.sock'));
	assert.ok(run.includes('DASHBOARD_PASSWORD'));
	assert.equal(run.at(-1), 'devcontainer-dashboard:ddash-test');
	assert.ok(result.calls.some((args) => args[0] === 'exec'));
	assert.ok(!JSON.stringify(result.calls).includes('do-not-log-this'));
	assert.doesNotMatch(result.stdout + result.stderr, /do-not-log-this/);
});

test('supports workspace, socket, port, and matching build/run platform overrides', (t) => {
	const f = fixture(t);
	const result = f.run([
		'--workspace', join(f.dir, 'other'),
		'--socket', '/run/user/1000/docker.sock',
		'--port', '4317',
		'--platform', 'linux/amd64'
	]);
	assert.equal(result.status, 0, result.stderr);
	for (const operation of ['buildx', 'run']) {
		const call = result.calls.find((args) => args[0] === operation && args.includes('--platform'));
		assert.equal(call[call.indexOf('--platform') + 1], 'linux/amd64');
	}
	assert.match(result.stdout, /127.0.0.1:4317/);
});

for (const [name, args, env, diagnostic] of [
	['existing container', [], { EXISTING: '1' }, /already exists/],
	['missing password', [], { DASHBOARD_PASSWORD: '' }, /non-empty DASHBOARD_PASSWORD/],
	['build failure', [], { FAIL_BUILD: '1' }, /./s],
	['invalid port', ['--port', '65536'], {}, /--port/],
	['relative workspace', ['--workspace', 'relative'], {}, /absolute/],
	['comma in path', ['--workspace', '/tmp/a,b'], {}, /commas/],
	['missing option value', ['--socket'], {}, /requires a value/],
	['unknown option', ['--replace'], {}, /Unknown option/]
]) {
	test(`fails without starting a container: ${name}`, (t) => {
		const result = fixture(t).run(args, env);
		assert.notEqual(result.status, 0);
		if (name !== 'build failure') assert.match(result.stderr, diagnostic);
		assert.ok(!result.calls.some((call) => call[0] === 'run'));
	});
}

for (const [name, env] of [
	['exited', { STATE: 'exited' }],
	['unhealthy', { HEALTH: 'unhealthy' }],
	['missing healthcheck', { HEALTH: 'none' }],
	['readiness timeout', { HEALTH: 'starting' }]
]) {
	test(`retains the container for inspection after ${name}`, (t) => {
		const result = fixture(t).run([], env);
		assert.notEqual(result.status, 0);
		assert.match(result.stdout + result.stderr, /retained/);
		assert.ok(result.calls.some((call) => call[0] === 'logs'));
		assert.ok(!result.calls.some((call) => ['rm', 'stop', 'kill'].includes(call[0])));
	});
}

test('help needs no Docker daemon or password', (t) => {
	const result = fixture(t).run(['--help'], { DASHBOARD_PASSWORD: '' });
	assert.equal(result.status, 0);
	assert.match(result.stdout, /current working tree/);
	assert.equal(result.calls.length, 0);
});

test('supports a detached checkout without changing its revision', (t) => {
	const result = fixture(t).run([], { DETACHED: '1' });
	assert.equal(result.status, 0);
	assert.match(result.stdout, /detached HEAD at abcdef1234567890/);
});

test('a failed HTTP check cannot report readiness or remove the container', (t) => {
	const result = fixture(t).run([], { FAIL_HTTP: '1' });
	assert.notEqual(result.status, 0);
	assert.doesNotMatch(result.stdout, /Ready:/);
	assert.ok(!result.calls.some((call) => ['rm', 'stop', 'kill'].includes(call[0])));
});

test('passes the exported external origin to Docker without widening the port binding', (t) => {
	const result = fixture(t).run([], { ORIGIN: 'https://dashboard.example.ts.net' });
	assert.equal(result.status, 0, result.stderr);
	const run = result.calls.find((args) => args[0] === 'run');
	const index = run.indexOf('ORIGIN');
	assert.ok(index > 0);
	assert.equal(run[index - 1], '--env');
	assert.ok(run.includes('127.0.0.1:3001:3000'));
	assert.match(result.stdout, /External origin: https:\/\/dashboard\.example\.ts\.net/);
	const build = result.calls.find((args) => args[0] === 'buildx' && args[1] === 'build');
	assert.ok(!build.includes('ORIGIN'));
});
