/**
 * Source/configuration regressions for the host-agent runner. No Docker or real
 * credentials are used. Run: node --test scripts/tests/devcontainer-agent.test.mjs
 * Integration tests use a real Unix socket and mocked CLI commands; they do not
 * prove Docker mounts, privilege dropping or successful SSH authentication.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AGENT_TARGET, agentSource, commandTarget, parseConfiguration, withAgent } from '../devcontainer-agent.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Keep JSONC strings literal, including comment markers and escaped quotes. */
test('parses comments and trailing commas without changing strings', () => {
	const config = parseConfiguration(`{
		// ignored
		"image": "registry.test/image:latest", /* ignored */
		"url": "https://example.test/a,b/}",
		"literal": "// not a comment /* here */",
		"mounts": ["source=/a,target=/b,type=bind",],
	}`);
	assert.equal(config.url, 'https://example.test/a,b/}');
	assert.equal(config.literal, '// not a comment /* here */');
	assert.equal(config.mounts.length, 1);
	for (const invalid of ['[]', 'null', '{"x":}', '{"x":1,,}']) {
		assert.throws(() => parseConfiguration(invalid));
	}
});

test('adds the same agent mount and runtime environment for image, Dockerfile and Compose', () => {
	for (const base of [
		{ image: 'example/image' },
		{ build: { dockerfile: './Dockerfile', context: '../..' } },
		{ dockerComposeFile: ['../compose.yml', './extra.yml'], service: 'development' }
	]) {
		const input = { ...base, remoteUser: '${localEnv:USER}', containerEnv: { KEEP: 'yes' }, remoteEnv: { OTHER: '${containerEnv:PATH}' } };
		const output = withAgent(input, '/run/user/1000/ssh-agent');
		assert.equal(output.containerEnv.SSH_AUTH_SOCK, AGENT_TARGET);
		assert.equal(output.remoteEnv.SSH_AUTH_SOCK, AGENT_TARGET);
		assert.equal(output.containerEnv.KEEP, 'yes');
		assert.equal(output.remoteEnv.OTHER, '${containerEnv:PATH}');
		assert.equal(output.remoteUser, '${localEnv:USER}');
		assert.deepEqual(output.mounts, [{ type: 'bind', source: '/run/user/1000/ssh-agent', target: AGENT_TARGET }]);
		assert.equal(input.mounts, undefined);
		assert.deepEqual(output.build, base.build);
		assert.deepEqual(output.dockerComposeFile, base.dockerComposeFile);
	}
});

test('replaces explicit agent mounts without adding a second socket and preserves unrelated mounts', () => {
	const result = withAgent({
		mounts: [
			'source=${localEnv:SSH_AUTH_SOCK},target=/tmp/vscode-agent,type=bind',
			{ type: 'volume', source: 'history', target: '/history' }
		],
		remoteEnv: { SSH_AUTH_SOCK: '/tmp/vscode-agent' }
	}, '/run/agent');
	assert.equal(result.mounts.length, 2);
	assert.equal(result.mounts[0].source, 'history');
	assert.equal(result.mounts[1].source, '/run/agent');
	assert.equal(result.remoteEnv.SSH_AUTH_SOCK, AGENT_TARGET);
});

test('refuses a conflicting reserved target or a private-key directory mount', () => {
	for (const mounts of [
		[{ type: 'bind', source: '/unrelated', target: AGENT_TARGET }],
		['source=${localEnv:HOME}/.ssh,target=/home/developer/.ssh,type=bind'],
		[{ type: 'bind', source: '/home/operator/.ssh', target: '/credentials' }]
	]) assert.throws(() => withAgent({ mounts }, '/run/agent'));
	assert.throws(() => withAgent({ mounts: 'not-an-array' }, '/run/agent'));
});

test('agent paths and managed argv fail closed without shell interpretation', () => {
	assert.equal(agentSource({ SSH_AUTH_SOCK: '/run/user/1000/agent with spaces' }), '/run/user/1000/agent with spaces');
	for (const source of ['', 'relative', '/run/../agent', '/tmp/a,b', '/tmp/a\nb', '/tmp/$AGENT', '/tmp/a:b']) {
		assert.throws(() => agentSource({ SSH_AUTH_SOCK: source }));
	}
	const workspace = "/workspace/repo ' $HOME; $(not-a-command)";
	assert.deepEqual(commandTarget(['up', '--workspace-folder', workspace]), { workspace, config: undefined });
	for (const args of [[], ['exec'], ['up', '--workspace-folder', 'relative'], ['up', '--workspace-folder', '/repo', '--override-config', '/evil']]) {
		assert.throws(() => commandTarget(args));
	}
});

/** Execute only the pure launcher phases for mount grammar and validation checks. */
function launcher(args = [], socket = '/run/user/1000/agent') {
	const script = `source <(sed '$d' "$1")
shift
parse_arguments --workspace /workspaces --no-create-workspace --host-user developer --host-uid 1000 --host-gid 1000 --host-home /home/developer "$@"
validate_env_files
resolve_identity
validate_options
validate_ssh_agent
prepare_arguments
printf '%s\\0' "\${ARGS[@]}"
`;
	const result = spawnSync('bash', ['-c', script, 'test', join(root, 'scripts/run-dashboard.sh'), ...args], {
		encoding: 'utf8', env: { ...process.env, SSH_AUTH_SOCK: socket }
	});
	return { ...result, args: result.stdout.split('\0') };
}

test('launcher requires the agent and rejects both removed directory flags', () => {
	for (const args of [['--ssh-dir'], ['--no-ssh-dir']]) {
		const result = launcher(args);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /removed.*SSH_AUTH_SOCK/);
	}
	assert.match(launcher([], '').stderr, /Export SSH_AUTH_SOCK/);
	assert.notEqual(launcher([], '/tmp/a:b').status, 0);
});

test('launcher separates known_hosts from the agent and explicitly overrides env files', () => {
	const result = launcher(['--ssh-known-hosts', '/home/developer/.ssh/known_hosts']);
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.args.includes('SSH_AUTH_SOCK=/run/user/1000/agent'));
	assert.ok(result.args.includes('type=bind,source=/run/user/1000/agent,target=/run/user/1000/agent,readonly'));
	assert.ok(result.args.includes('type=bind,source=/home/developer/.ssh/known_hosts,target=/etc/ssh/ssh_known_hosts,readonly'));
	assert.ok(!result.args.some((arg) => arg.includes('target=/home/developer/.ssh')));
});

/** Make an agent socket and fake CLI boundaries without a daemon or real keys. */
async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), 'dh-agent-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const bin = join(directory, 'bin');
	const workspace = join(directory, "repo with spaces ' $literal");
	const config = join(workspace, '.devcontainer/named/devcontainer.json');
	const socket = join(directory, 'agent.sock');
	const log = join(directory, 'calls.jsonl');
	await mkdir(bin);
	await mkdir(dirname(config), { recursive: true });
	await writeFile(config, '{/* configuration */ "image":"fixture", "remoteUser":"developer",}');
	const server = createServer().listen(socket);
	await once(server, 'listening');
	t.after(() => server.close());
	await writeFile(join(bin, 'ssh-add'), '#!/bin/sh\nexit "${AGENT_EXIT:-0}"\n', { mode: 0o755 });
	await writeFile(join(bin, 'devcontainer'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const override = args[args.indexOf('--override-config') + 1];
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({args, override, config: JSON.parse(fs.readFileSync(override, 'utf8'))})+'\\n');
process.exit(args[0] === 'exec' ? Number(process.env.REMOTE_EXIT || 0) : Number(process.env.UP_EXIT || 0));
`, { mode: 0o755 });
	return {
		workspace, config, socket,
		run(env = {}, rebuild = false) {
			return spawnSync(process.execPath, [join(root, 'scripts/devcontainer-agent.mjs'), 'up', '--workspace-folder', workspace, '--config', config,
				...(rebuild ? ['--id-label', `devcontainer.local_folder=${workspace}`, '--id-label', `devcontainer.config_file=${config}`, '--remove-existing-container'] : [])], {
				encoding: 'utf8', timeout: 10000,
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SSH_AUTH_SOCK: socket, TEST_LOG: log, ...env }
			});
		},
		async calls() {
			try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
			catch (error) { if (error.code === 'ENOENT') return []; throw error; }
		}
	};
}

test('runner preserves original configuration identity and verifies the effective remote user', async (t) => {
	const f = await fixture(t);
	const original = await readFile(f.config, 'utf8');
	const result = f.run({}, true);
	assert.equal(result.status, 0, result.stderr);
	const calls = await f.calls();
	assert.equal(calls.length, 2);
	assert.equal(calls[0].args[0], 'up');
	assert.ok(calls[0].args.includes('--remove-existing-container'));
	assert.equal(calls[0].args[calls[0].args.indexOf('--config') + 1], f.config);
	assert.equal(calls[0].config.containerEnv.SSH_AUTH_SOCK, AGENT_TARGET);
	assert.equal(calls[1].args[0], 'exec');
	assert.ok(calls[1].args.includes(`SSH_AUTH_SOCK=${AGENT_TARGET}`));
	assert.ok(!calls[1].args.includes('--user'));
	assert.equal(await readFile(f.config, 'utf8'), original);
	await assert.rejects(readFile(calls[0].override), { code: 'ENOENT' });
});

test('an empty agent is accepted, but an unreachable agent never starts the CLI', async (t) => {
	const empty = await fixture(t);
	assert.equal(empty.run({ AGENT_EXIT: '1' }).status, 0);
	const missing = await fixture(t);
	assert.notEqual(missing.run({ AGENT_EXIT: '2' }).status, 0);
	assert.deepEqual(await missing.calls(), []);
});

test('a failed up or remote verification never reports managed build success', async (t) => {
	const up = await fixture(t);
	assert.equal(up.run({ UP_EXIT: '7' }).status, 7);
	assert.equal((await up.calls()).length, 1);
	const remote = await fixture(t);
	const result = remote.run({ REMOTE_EXIT: '2' });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /verification failed.*explicit rebuild/);
	const calls = await remote.calls();
	assert.equal(calls.length, 2);
	await assert.rejects(readFile(calls[0].override), { code: 'ENOENT' });
});
