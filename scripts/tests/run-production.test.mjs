import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), 'ddash-runner-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const log = join(dir, 'calls');
	writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
	writeFileSync(join(bin, 'git'), `#!/bin/sh
case "$*" in
*--show-toplevel*) echo "$FIXTURE_ROOT" ;;
*--porcelain*) echo "\${DIRTY_OUTPUT:-}" ;;
*symbolic-ref*) test "\${DETACHED:-}" != 1 || exit 1; echo feature/current-branch ;;
*) echo abcdef1234567890 ;;
esac
`, { mode: 0o755 });
	writeFileSync(join(bin, 'getent'), '#!/bin/sh\necho "$2:x:4567:5678::/home/original:/bin/bash"\n', { mode: 0o755 });
	writeFileSync(join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({args, user:process.env.HOST_USER, uid:process.env.HOST_UID, gid:process.env.HOST_GID, home:process.env.HOST_HOME})+'\\n');
if(args[0]==='container') process.exit(process.env.EXISTING==='1'?0:1);
if(args[0]==='buildx' && args[1]==='build' && process.env.FAIL_BUILD==='1') process.exit(2);
if(args[0]==='exec' && process.env.FAIL_HTTP==='1') process.exit(3);
if(args[0]==='inspect') console.log(args[2].includes('Health') ? (process.env.HEALTH||'healthy') : (process.env.STATE||'running'));
`, { mode: 0o755 });
	return {
		dir,
		run(script = 'run-production.sh', args = [], env = {}, input) {
			const result = spawnSync('bash', [join(root, 'scripts', script), ...args], {
				encoding: 'utf8', timeout: 10000, input,
				env: {
					...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_ROOT: dir,
					CALL_LOG: log, DASHBOARD_PASSWORD: 'never-log-this', DASHBOARD_TEST_NAME: 'ddash-test',
					DASHBOARD_HEALTH_TIMEOUT: '2', DASHBOARD_TEST_PORT: '3001', DOCKER_DEFAULT_PLATFORM: '',
					HOST_USER: 'operator', HOST_UID: '2345', HOST_GID: '3456', HOST_HOME: '/home/operator',
					WORKSPACE_ROOT: join(dir, 'workspace with spaces'), DOCKER_SOCKET: '/host/docker.sock',
					SSH_AUTH_SOCK: '', ORIGIN: '', DDASH_DEV_BOOTSTRAP: '0', DDASH_SSH_DIRECTORY: '0',
					...env
				}
			});
			const calls = readFileSync(log, { encoding: 'utf8', flag: 'a+' }).trim().split('\n').filter(Boolean).map(JSON.parse);
			return { ...result, calls };
		}
	};
}

test('builds current working tree, passes runtime identity and supports no SSH agent', (t) => {
	const f = fixture(t);
	const result = f.run('run-production.sh', [], { DIRTY_OUTPUT: ' M src/server.ts' });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /local changes: true/);
	const build = result.calls.find((c) => c.args[0] === 'buildx' && c.args[1] === 'build').args;
	assert.ok(build.includes('--load'));
	assert.ok(!build.includes('--push'));
	const run = result.calls.find((c) => c.args[0] === 'run');
	assert.equal(run.user, 'operator');
	assert.equal(run.uid, '2345');
	assert.equal(run.gid, '3456');
	assert.equal(run.home, '/home/operator');
	assert.ok(run.args.includes('127.0.0.1:3001:3000'));
	assert.ok(run.args.includes(`type=bind,source=${f.dir}/workspace with spaces,target=${f.dir}/workspace with spaces`));
	assert.ok(run.args.includes('type=bind,source=/host/docker.sock,target=/var/run/docker.sock'));
	assert.ok(!run.args.includes('SSH_AUTH_SOCK'));
	assert.equal(run.args.at(-1), 'devcontainer-dashboard:ddash-test');
	assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(result.calls), /never-log-this/);
});

test('passes an optional agent at the same absolute host path', (t) => {
	const result = fixture(t).run('run-production.sh', [], { SSH_AUTH_SOCK: '/run/user/2345/agent' });
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.calls.find((c) => c.args[0] === 'run').args.includes('type=bind,source=/run/user/2345/agent,target=/run/user/2345/agent,readonly'));
});

test('sudo captures the original operator when explicit identity is absent', (t) => {
	const result = fixture(t).run('run-production.sh', [], {
		HOST_USER: '', HOST_UID: '', HOST_GID: '', HOST_HOME: '', SUDO_USER: 'original'
	});
	assert.equal(result.status, 0, result.stderr);
	const run = result.calls.find((c) => c.args[0] === 'run');
	assert.deepEqual([run.user, run.uid, run.gid, run.home], ['original', '4567', '5678', '/home/original']);
});

test('supports platform, port and origin without passing secrets to the build', (t) => {
	const result = fixture(t).run('run-production.sh', ['--port', '4317', '--platform', 'linux/amd64'], { ORIGIN: 'https://dashboard.example' });
	assert.equal(result.status, 0, result.stderr);
	for (const operation of ['buildx', 'run']) {
		assert.ok(result.calls.some((c) => c.args[0] === operation && c.args.includes('linux/amd64')));
	}
	assert.match(result.stdout, /127.0.0.1:4317/);
	assert.match(result.stdout, /External origin: https:\/\/dashboard.example/);
});

for (const [name, args, env] of [
	['root identity', [], { HOST_UID: '0' }],
	['partial identity', [], { HOST_HOME: '' }],
	['missing password', [], { DASHBOARD_PASSWORD: '' }],
	['missing SSH directory', [], { DDASH_SSH_DIRECTORY: '1' }],
	['comma path', ['--workspace', '/tmp/a,b'], {}],
	['relative workspace', ['--workspace', 'relative'], {}],
	['invalid port', ['--port', '65536'], {}],
	['missing value', ['--socket'], {}],
	['unknown option', ['--replace'], {}],
	['existing container', [], { EXISTING: '1' }],
	['failed build', [], { FAIL_BUILD: '1' }]
]) {
	test(`does not start a container: ${name}`, (t) => {
		const result = fixture(t).run('run-production.sh', args, env);
		assert.notEqual(result.status, 0);
		assert.ok(!result.calls.some((c) => c.args[0] === 'run'));
	});
}

for (const env of [{ STATE: 'exited' }, { HEALTH: 'none' }, { HEALTH: 'unhealthy' }, { HEALTH: 'starting' }, { FAIL_HTTP: '1' }]) {
	test(`retains failed test resources: ${JSON.stringify(env)}`, (t) => {
		const result = fixture(t).run('run-production.sh', [], env);
		assert.notEqual(result.status, 0);
		assert.doesNotMatch(result.stdout, /Ready:/);
		assert.ok(!result.calls.some((c) => ['rm', 'stop', 'kill'].includes(c.args[0])));
	});
}

test('help needs neither identity nor Docker', (t) => {
	const result = fixture(t).run('run-production.sh', ['--help'], { HOST_UID: '' });
	assert.equal(result.status, 0);
	assert.equal(result.calls.length, 0);
});

test('direct installer passes identity without requiring SSH or bootstrap', (t) => {
	const result = fixture(t).run('run-dashboard.sh');
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.calls.find((c) => c.args[0] === 'run').uid, '2345');
});

test('generated Compose persists identity and origin but not the password', (t) => {
	const f = fixture(t);
	// Skip interactive prompts using a pseudo-terminal for the origin question.
	const result = spawnSync('script', ['-q', '-e', '-c', `bash '${root}/scripts/run-dashboard-compose.sh'`, '/dev/null'], {
		encoding: 'utf8', input: '\n', timeout: 10000,
		env: {
			...process.env, PATH: `${f.dir}/bin:${process.env.PATH}`, CALL_LOG: join(f.dir, 'calls'),
			HOST_USER: 'operator', HOST_UID: '2345', HOST_GID: '3456', HOST_HOME: '/home/operator',
			WORKSPACE_ROOT: join(f.dir, 'workspace with spaces'), DDASH_CONFIG_DIR: join(f.dir, 'config'),
			DASHBOARD_PASSWORD: 'never-log-this', DDASH_DEV_BOOTSTRAP: '0', DDASH_SSH_DIRECTORY: '0',
			SSH_AUTH_SOCK: '', DDASH_ORIGIN: 'https://dashboard.example'
		}
	});
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const generated = readFileSync(join(f.dir, 'config/docker-compose.yml'), 'utf8');
	assert.match(generated, /HOST_UID: '2345'/);
	assert.match(generated, /ORIGIN: 'https:\/\/dashboard.example'/);
	assert.match(generated, /create_host_path: false/);
	assert.doesNotMatch(generated, /never-log-this|\/home\/ddash/);
});
