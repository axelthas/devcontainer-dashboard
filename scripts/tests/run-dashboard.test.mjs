// Test the standalone launcher without a Docker daemon or real deployment.
//
// Usage: node --test scripts/tests/run-dashboard.test.mjs (Node 22).
// Mock Git, passwd lookup and Docker calls in temporary directories; preserve argv
// and exported identity in a call log. Registry and build modes share identity,
// secret, origin, mount and non-disclosure cases; mode-specific cases cover the
// pull/run and buildx/run contracts and retained failure resources. The launcher
// reads no deployment environment, so one case asserts removed variables are ignored.
// Interactive curl-piped cases require util-linux script for a disposable PTY.
// No real image is built or pulled. Do not infer Docker/privilege behavior from
// these mocks. node:test owns discovery and execution; cleanup is per test.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Identity flags used by most unattended cases; passwd-fallback cases omit them.
const identityFlags = [
	'--host-user',
	'operator',
	'--host-uid',
	'2345',
	'--host-gid',
	'3456',
	'--host-home',
	'/home/operator'
];

// Create mock Git/passwd/Docker commands and an isolated environment for launcher tests.
// Record exact argv, identity and a password length marker (never the value); register cleanup.
function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), 'ddash-launcher-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const log = join(dir, 'calls');
	writeFileSync(log, '');
	writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
	writeFileSync(join(dir, 'password-file'), 'never-log-this\n');
	writeFileSync(join(dir, 'password-file-raw'), 'no-newline-secret');
	writeFileSync(join(dir, 'password-file-multi'), 'multi\n\n');
	writeFileSync(join(dir, 'password-file-empty'), '');
	writeFileSync(
		join(bin, 'git'),
		`#!/bin/sh
case "$*" in
*--show-toplevel*) echo "$FIXTURE_ROOT" ;;
*--porcelain*) printf '%s' "\${DIRTY_OUTPUT:-}" ;;
*symbolic-ref*) test "\${DETACHED:-}" != 1 || exit 1; echo feature/test ;;
*) echo abcdef1234567890 ;;
esac
`,
		{ mode: 0o755 }
	);
	writeFileSync(
		join(bin, 'getent'),
		'#!/bin/sh\necho "$2:x:4567:5678::/home/original:/bin/bash"\n',
		{ mode: 0o755 }
	);
	writeFileSync(
		join(bin, 'docker'),
		`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({args, user:process.env.HOST_USER, uid:process.env.HOST_UID, gid:process.env.HOST_GID, home:process.env.HOST_HOME, passwordChars:(process.env.DASHBOARD_PASSWORD||'').length})+'\\n');
if(args[0]==='container') process.exit(process.env.EXISTING==='1'?0:1);
if(args[0]==='buildx' && args[1]==='build' && process.env.FAIL_BUILD==='1') process.exit(2);
if(args[0]==='run' && process.env.FAIL_RUN==='1') process.exit(2);
if(args[0]==='exec' && process.env.FAIL_HTTP==='1') process.exit(3);
if(args[0]==='inspect') console.log(args[2].includes('Health') ? (process.env.HEALTH||'healthy') : (process.env.STATE||'running'));
`,
		{ mode: 0o755 }
	);
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		FIXTURE_ROOT: dir,
		CALL_LOG: log,
		SSH_AUTH_SOCK: '',
		SUDO_USER: ''
	};
	return {
		dir,
		passwordFile: join(dir, 'password-file'),
		env,
		// Execute the launcher with per-test overrides; return captured output/status and only
		// the calls recorded by this run, so several runs can share one fixture.
		run(args = [], overrides = {}, interactive = false, input = '\n') {
			const path = join(root, 'scripts', 'run-dashboard.sh');
			const offset = readFileSync(log, 'utf8').length;
			// Interactive cases emulate curl | bash: the script arrives on stdin and flags
			// must be forwarded to `bash -s --` because the launcher reads no environment.
			const quote = (value) => `'${String(value).replaceAll(`'`, `'\\''`)}'`;
			const command = `cat '${path}' | bash -s -- ${args.map(quote).join(' ')}`;
			const result = spawnSync(
				interactive ? 'script' : 'bash',
				interactive ? ['-q', '-e', '-c', command, '/dev/null'] : [path, ...args],
				{
					encoding: 'utf8',
					timeout: 10000,
					input,
					env: { ...env, ...overrides }
				}
			);
			const calls = readFileSync(log, 'utf8')
				.slice(offset)
				.trim()
				.split('\n')
				.filter(Boolean)
				.map(JSON.parse);
			return { ...result, calls };
		},
		// Drive the curl-piped launcher through a disposable PTY, writing each input only
		// after its prompt text appears, so hidden-input prompts run with echo disabled.
		interactive(args = [], inputs = [], overrides = {}) {
			const path = join(root, 'scripts', 'run-dashboard.sh');
			const quote = (value) => `'${String(value).replaceAll(`'`, `'\\''`)}'`;
			const command = `cat '${path}' | bash -s -- ${args.map(quote).join(' ')}`;
			const offset = readFileSync(log, 'utf8').length;
			return new Promise((resolve, reject) => {
				const child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], {
					env: { ...env, ...overrides }
				});
				let output = '';
				let index = 0;
				const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
				child.stdout.on('data', (chunk) => {
					output += chunk;
					if (index < inputs.length && output.includes(inputs[index].at)) {
						child.stdin.write(inputs[index].write);
						index++;
					}
				});
				child.on('error', (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.on('exit', (code) => {
					clearTimeout(timer);
					const calls = readFileSync(log, 'utf8')
						.slice(offset)
						.trim()
						.split('\n')
						.filter(Boolean)
						.map(JSON.parse);
					resolve({ code, output, calls });
				});
			});
		}
	};
}

// Registry mode with the standard unattended inputs: explicit identity, file password, no local mkdir.
function registry(f, args = [], overrides = {}, interactive = false, input = '\n') {
	return f.run(
		[
			...identityFlags,
			'--non-interactive',
			'--no-create-workspace',
			'--password-file',
			f.passwordFile,
			...args
		],
		overrides,
		interactive,
		input
	);
}

// Build mode with the same standard inputs plus the build switch.
function build(f, args = [], overrides = {}, interactive = false, input = '\n') {
	return registry(f, ['--build', ...args], overrides, interactive, input);
}

const runCall = (r) => r.calls.find((c) => c.args[0] === 'run');
const buildCall = (r) => r.calls.find((c) => c.args[0] === 'buildx' && c.args[1] === 'build');

test('registry mode: pulls the default image and runs attached with stable volumes', (t) => {
	const f = fixture(t);
	const r = registry(f);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /dev-bootstrap: 0/);
	assert.match(r.stdout, /Dashboard address/);
	assert.deepEqual(r.calls.find((c) => c.args[0] === 'pull').args, [
		'pull',
		'ghcr.io/axelthas/devcontainer-dashboard:latest'
	]);
	const run = runCall(r);
	assert.ok(run.args.includes('--rm'));
	assert.ok(run.args.includes('127.0.0.1:3000:3000'));
	assert.ok(run.args.includes('dashboard_data:/data'));
	assert.ok(run.args.includes('ddash_zsh_data:/dashboard-history'));
	assert.ok(run.args.includes('type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock'));
	assert.ok(
		run.args.includes(
			'type=bind,source=/home/operator/ddash-workspace,target=/home/operator/ddash-workspace'
		)
	);
	assert.deepEqual(
		[run.user, run.uid, run.gid, run.home],
		['operator', '2345', '3456', '/home/operator']
	);
	assert.equal(run.passwordChars, 14);
	assert.equal(run.args.at(-1), 'ghcr.io/axelthas/devcontainer-dashboard:latest');
	// adapter-node rejects an empty ORIGIN at startup, so a blank origin is not forwarded.
	assert.ok(!run.args.includes('ORIGIN'));
});

test('registry mode: image, port, bind address, hook and SSH directory flags', (t) => {
	const f = fixture(t);
	const r = registry(f, [
		'--image',
		'example.test/dashboard:dev',
		'--port',
		'4321',
		'--bind-address',
		'0.0.0.0',
		'--bootstrap',
		'--ssh-dir'
	]);
	assert.equal(r.status, 0, r.stderr);
	const pull = r.calls.find((c) => c.args[0] === 'pull');
	assert.deepEqual(pull.args, ['pull', 'example.test/dashboard:dev']);
	const run = runCall(r);
	assert.ok(run.args.includes('0.0.0.0:4321:3000'));
	assert.ok(run.args.includes('example.test/dashboard:dev'));
	assert.equal(run.args.at(-1), 'dev-bootstrap');
	assert.ok(
		run.args.includes('type=bind,source=/home/operator/.ssh,target=/home/operator/.ssh,readonly')
	);
	assert.match(r.stdout, /dev-bootstrap: 1/);
});

test('registry mode: forwards an exported SSH agent socket read-only', (t) => {
	const f = fixture(t);
	const r = registry(f, [], { SSH_AUTH_SOCK: '/run/user/2345/agent' });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(
		runCall(r).args.includes(
			'type=bind,source=/run/user/2345/agent,target=/run/user/2345/agent,readonly'
		)
	);
});

test('registry mode: interactive workspace prompt through a curl-piped PTY', async (t) => {
	const f = fixture(t);
	const r = await f.interactive(
		[...identityFlags, '--password-file', f.passwordFile, '--no-create-workspace'],
		[{ at: 'Workspace directory', write: '\n' }]
	);
	assert.equal(r.code, 0, r.output);
	assert.match(r.output, /Workspace directory/);
	assert.ok(
		runCall(r).args.includes(
			'type=bind,source=/home/operator/ddash-workspace,target=/home/operator/ddash-workspace'
		)
	);
});

test('registry mode: password prompt through a curl-piped PTY, secret never echoed', async (t) => {
	const f = fixture(t);
	const r = await f.interactive(
		[...identityFlags, '--no-create-workspace'],
		[
			{ at: 'Workspace directory', write: '\n' },
			{ at: 'Dashboard password:', write: 'typed-secret\n' }
		]
	);
	assert.equal(r.code, 0, r.output);
	assert.match(r.output, /Dashboard password/);
	assert.equal(runCall(r).passwordChars, 'typed-secret'.length);
	// The value is written only after read -s disabled terminal echo, so the
	// typescript must not contain it even though script records every keystroke.
	assert.doesNotMatch(r.output, /typed-secret/);
});

test('captures the original sudo operator from passwd', (t) => {
	const f = fixture(t);
	const r = f.run(
		['--non-interactive', '--no-create-workspace', '--password-file', f.passwordFile],
		{ SUDO_USER: 'original' }
	);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(
		[runCall(r).user, runCall(r).uid, runCall(r).gid, runCall(r).home],
		['original', '4567', '5678', '/home/original']
	);
});

test('help needs no identity, password or daemon and ignores the environment', (t) => {
	const f = fixture(t);
	const r = f.run(['--help'], {
		DASHBOARD_PASSWORD: 'ignored',
		WORKSPACE_ROOT: '/ignored',
		DDASH_DEV_BOOTSTRAP: '1'
	});
	assert.equal(r.status, 0);
	assert.equal(r.calls.length, 0);
	assert.match(r.stdout, /--password-file/);
	assert.match(r.stdout, /process lists/);
	const short = fixture(t).run(['-h']);
	assert.equal(short.status, 0);
	assert.equal(short.calls.length, 0);
});

test('ignores the removed environment-variable interface', (t) => {
	const f = fixture(t);
	const r = registry(f, [], {
		WORKSPACE_ROOT: '/env/workspace',
		DASHBOARD_PASSWORD: 'env-secret-value',
		DDASH_DEV_BOOTSTRAP: '1',
		DDASH_SSH_DIRECTORY: '1',
		HOST_UID: '9999',
		DASHBOARD_IMAGE: 'env-image:1',
		DASHBOARD_TEST_PORT: '9999'
	});
	assert.equal(r.status, 0, r.stderr);
	const run = runCall(r);
	assert.deepEqual([run.user, run.uid], ['operator', '2345']);
	assert.ok(
		run.args.includes(
			'type=bind,source=/home/operator/ddash-workspace,target=/home/operator/ddash-workspace'
		)
	);
	assert.equal(run.passwordChars, 14);
	assert.equal(run.args.at(-1), 'ghcr.io/axelthas/devcontainer-dashboard:latest');
	assert.ok(!run.args.includes('dev-bootstrap'));
	assert.ok(!run.args.some((a) => a.includes('/.ssh')));
});

test('password-file trims exactly one trailing newline', (t) => {
	const f = fixture(t);
	const raw = f.run([
		...identityFlags,
		'--non-interactive',
		'--no-create-workspace',
		'--password-file',
		join(f.dir, 'password-file-raw')
	]);
	assert.equal(raw.status, 0, raw.stderr);
	assert.equal(runCall(raw).passwordChars, 'no-newline-secret'.length);
	const multi = f.run([
		...identityFlags,
		'--non-interactive',
		'--no-create-workspace',
		'--password-file',
		join(f.dir, 'password-file-multi')
	]);
	assert.equal(multi.status, 0, multi.stderr);
	assert.equal(runCall(multi).passwordChars, 'multi\n'.length);
});

test('password-file problems fail before any docker call', (t) => {
	const f = fixture(t);
	const missing = f.run([
		...identityFlags,
		'--non-interactive',
		'--no-create-workspace',
		'--password-file',
		join(f.dir, 'no-such-file')
	]);
	assert.notEqual(missing.status, 0);
	assert.match(missing.stderr, /Cannot read password file/);
	assert.equal(missing.calls.length, 0);
	const empty = f.run([
		...identityFlags,
		'--non-interactive',
		'--no-create-workspace',
		'--password-file',
		join(f.dir, 'password-file-empty')
	]);
	assert.notEqual(empty.status, 0);
	assert.match(empty.stderr, /must not be empty/);
	assert.equal(empty.calls.length, 0);
});

test('rejects --password together with --password-file', (t) => {
	const f = fixture(t);
	const r = registry(f, ['--password', 'cli-secret']);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /not both/);
	assert.equal(r.calls.length, 0);
});

test('explicit --password reaches the container without appearing in output', (t) => {
	const f = fixture(t);
	const r = f.run([
		...identityFlags,
		'--non-interactive',
		'--no-create-workspace',
		'--password',
		'cli-secret'
	]);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(runCall(r).passwordChars, 'cli-secret'.length);
	assert.doesNotMatch(r.stdout + r.stderr + JSON.stringify(r.calls), /cli-secret/);
});

test('non-interactive runs require --password or --password-file', (t) => {
	const f = fixture(t);
	const r = f.run([...identityFlags, '--non-interactive', '--no-create-workspace']);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /Non-interactive runs require/);
	assert.equal(r.calls.length, 0);
});

test('prompts without a terminal fail with guidance', (t) => {
	const f = fixture(t);
	const r = f.run([...identityFlags]);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /terminal/);
	assert.equal(r.calls.length, 0);
});

test('forwards a configured origin trimmed and accepts IPv6 authorities', (t) => {
	const f = fixture(t);
	const r = registry(f, ['--origin', 'https://dashboard.example/']);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(runCall(r).args.includes('ORIGIN=https://dashboard.example'));
	const v6 = registry(f, ['--origin', 'http://[::1]:3000']);
	assert.equal(v6.status, 0, v6.stderr);
	assert.ok(runCall(v6).args.includes('ORIGIN=http://[::1]:3000'));
});

test('forwards gateway and VS Code passthroughs only when flagged', (t) => {
	const f = fixture(t);
	const r = registry(f, [
		'--gateway',
		'--gateway-host',
		'172.17.0.1',
		'--gateway-ports',
		'9001:http,8443:https',
		'--vscode-ssh-host',
		'gitlab.example'
	]);
	assert.equal(r.status, 0, r.stderr);
	const args = runCall(r).args;
	for (const value of [
		'SERVICE_PROXY_ENABLED=1',
		'SERVICE_PROXY_HOST=172.17.0.1',
		'SERVICE_PROXY_PORTS=9001:http,8443:https',
		'VSCODE_SSH_HOST=gitlab.example'
	]) {
		assert.ok(args.includes(value), `missing ${value}`);
	}
	const plain = registry(f);
	assert.ok(!plain.calls.at(-1).args.some((a) => a.startsWith('SERVICE_PROXY')));
});

test('creates the workspace directory unless --no-create-workspace', (t) => {
	const f = fixture(t);
	const made = join(f.dir, 'made-ws');
	const r = f.run([
		...identityFlags,
		'--non-interactive',
		'--password-file',
		f.passwordFile,
		'--workspace',
		made
	]);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(existsSync(made));
	const skipped = join(f.dir, 'skipped-ws');
	const skippedRun = f.run([
		...identityFlags,
		'--non-interactive',
		'--password-file',
		f.passwordFile,
		'--workspace',
		skipped,
		'--no-create-workspace'
	]);
	assert.equal(skippedRun.status, 0, skippedRun.stderr);
	assert.ok(!existsSync(skipped));
});

test('supports workspace paths with spaces as same-path binds', (t) => {
	const f = fixture(t);
	const ws = join(f.dir, 'workspace with spaces');
	const r = f.run([
		...identityFlags,
		'--non-interactive',
		'--password-file',
		f.passwordFile,
		'--workspace',
		ws,
		'--no-create-workspace'
	]);
	assert.equal(r.status, 0, r.stderr);
	const run = runCall(r);
	assert.ok(run.args.includes(`type=bind,source=${ws},target=${ws}`));
	assert.ok(run.args.includes(`WORKSPACE_ROOT=${ws}`));
});

for (const [label, extra] of [
	['uid 0', ['--host-uid', '0']],
	['gid 0', ['--host-gid', '0']],
	['leading-zero uid', ['--host-uid', '01']],
	['uid over the bound', ['--host-uid', '2147483648']],
	['root user', ['--host-user', 'root']],
	['partial identity', ['--host-uid', '2345']],
	['invalid user', ['--host-user', 'x;id']],
	['system home', ['--host-home', '/etc/operator']],
	['traversal home', ['--host-home', '/home/../etc']],
	['double-slash home', ['--host-home', '/home//operator']],
	['reserved home', ['--host-home', '/dashboard-history/operator']],
	['relative socket', ['--socket', 'relative']],
	['port 65536', ['--port', '65536']],
	['port 0', ['--port', '0']],
	['non-numeric port', ['--port', 'abc']],
	['origin with path', ['--origin', 'https://example.com/path']],
	['origin with port 65536', ['--origin', 'https://example.com:65536']],
	['origin with credentials', ['--origin', 'https://${SECRET}']],
	['invalid image', ['--image', '-bad']],
	['invalid name', ['--build', '--name', 'Bad_Name']],
	['health timeout 0', ['--build', '--health-timeout', '0']],
	['gateway ports protocol', ['--gateway-ports', '9001:ftp']],
	['gateway ports port 0', ['--gateway-ports', '0:http']],
	['gateway ports trailing comma', ['--gateway-ports', '9001:http,']],
	['image in build mode', ['--build', '--image', 'example.test/x:1']],
	['bind address in build mode', ['--build', '--bind-address', '0.0.0.0']],
	['platform in registry mode', ['--platform', 'linux/amd64']],
	['name in registry mode', ['--name', 'ddash-x']],
	['health timeout in registry mode', ['--health-timeout', '5']],
	['unknown option', ['--replace']],
	['missing option value', ['--socket']]
]) {
	test(`rejects ${label}`, (t) => {
		const f = fixture(t);
		const r = f.run([
			'--non-interactive',
			'--no-create-workspace',
			'--password-file',
			f.passwordFile,
			...extra
		]);
		assert.notEqual(r.status, 0);
		assert.equal(runCall(r), undefined);
		assert.equal(buildCall(r), undefined);
	});
}

test('build mode: builds the checkout and verifies readiness', (t) => {
	const f = fixture(t);
	const r = build(f, ['--port', '4317', '--platform', 'linux/amd64', '--name', 'ddash-custom'], {
		DIRTY_OUTPUT: ' M file'
	});
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /local changes: true/);
	assert.match(r.stdout, /Ready: http:\/\/127.0.0.1:4317/);
	const built = buildCall(r);
	assert.ok(built.args.includes('--load') && !built.args.includes('--push'));
	assert.ok(built.args.includes('linux/amd64'));
	assert.ok(built.args.includes('org.opencontainers.image.revision=abcdef1234567890'));
	assert.ok(built.args.includes('devcontainer-dashboard.local-changes=true'));
	assert.ok(built.args.includes('devcontainer-dashboard:ddash-custom'));
	assert.equal(built.args.at(-1), '.');
	const run = runCall(r);
	assert.ok(run.args.includes('--detach'));
	assert.ok(run.args.includes('127.0.0.1:4317:3000'));
	assert.ok(run.args.includes('linux/amd64'));
	assert.ok(run.args.includes('ddash-custom-data:/data'));
	assert.ok(run.args.includes('ddash-custom-zsh:/dashboard-history'));
	assert.ok(r.calls.some((c) => c.args[0] === 'exec'));
});

test('build mode: unique default name, default workspace and loopback publication', (t) => {
	const f = fixture(t);
	const r = build(f);
	assert.equal(r.status, 0, r.stderr);
	const run = runCall(r);
	const name = run.args[run.args.indexOf('--name') + 1];
	assert.match(name, /^ddash-local-abcdef123456-\d+-\d+$/);
	assert.ok(
		run.args.includes(
			'type=bind,source=/home/operator/ddash-production-workspace,target=/home/operator/ddash-production-workspace'
		)
	);
	assert.ok(run.args.includes('127.0.0.1:3001:3000'));
	assert.ok(run.args.includes(`devcontainer-dashboard:${name}`));
});

test('build mode: forwards gateway passthroughs and a configured origin', (t) => {
	const f = fixture(t);
	const r = build(f, ['--gateway', '--gateway-ports', '9001:http']);
	assert.equal(r.status, 0, r.stderr);
	const args = runCall(r).args;
	assert.ok(args.includes('SERVICE_PROXY_ENABLED=1'));
	assert.ok(args.includes('SERVICE_PROXY_PORTS=9001:http'));
	assert.ok(!args.includes('ORIGIN'));
	const withOrigin = build(f, ['--origin', 'https://gateway.example']);
	assert.ok(runCall(withOrigin).args.includes('ORIGIN=https://gateway.example'));
});

for (const env of [
	{ STATE: 'exited' },
	{ HEALTH: 'none' },
	{ HEALTH: 'unhealthy' },
	{ HEALTH: 'starting' },
	{ FAIL_HTTP: '1' },
	{ FAIL_RUN: '1' }
]) {
	test(`build mode: failure retains test resources ${JSON.stringify(env)}`, (t) => {
		const r = build(fixture(t), ['--health-timeout', '1'], env);
		assert.notEqual(r.status, 0);
		assert.doesNotMatch(r.stdout, /Ready:/);
		assert.ok(!r.calls.some((c) => ['rm', 'stop', 'kill'].includes(c.args[0])));
	});
}

test('build mode: build failure prevents any container start', (t) => {
	const r = build(fixture(t), [], { FAIL_BUILD: '1' });
	assert.notEqual(r.status, 0);
	assert.equal(runCall(r), undefined);
});

test('build mode: an existing container name is rejected', (t) => {
	const r = build(fixture(t), ['--name', 'ddash-custom'], { EXISTING: '1' });
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /Container already exists/);
	assert.equal(runCall(r), undefined);
});
