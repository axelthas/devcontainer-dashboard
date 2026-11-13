/**
 * Source regressions for rebuild target safety, argv, orchestration, and HTTP contracts.
 * Run with Node 22.13+: node --experimental-strip-types --test scripts/tests/devcontainer-rebuild.test.mjs
 * Production TypeScript is stripped into a temporary module graph. Only Docker, PTY, logs,
 * authentication helpers, and SvelteKit response boundaries are mocked. No Docker is required.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const previousEnv = { VITEST: process.env.VITEST, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT };
const state = (globalThis.__dashboardRebuildTests = {});
let temporary;
let root;
let repo;
let config;
let labels;
let targets;
let builds;
let actions;
let buildRoute;
let terminals;
const fullId = 'a'.repeat(64);

/** Copy the actual source, failing loudly if a dependency replacement no longer matches. */
async function sourceModule(sourcePath, name, replacements = {}) {
	let source = await readFile(join(repository, sourcePath), 'utf8');
	source = stripTypeScriptTypes(source);
	for (const [from, to] of Object.entries(replacements)) {
		assert.ok(source.includes(from), `Expected dependency ${from} in ${sourcePath}`);
		source = source.replaceAll(from, to);
	}
	await writeFile(join(temporary, name), source);
	return import(pathToFileURL(join(temporary, name)).href);
}

/** Build an isolated fixture with two named configurations and shell-significant path characters. */
before(async () => {
	temporary = await mkdtemp(join(tmpdir(), 'ddash-rebuild-'));
	root = join(temporary, 'workspace');
	repo = join(root, "task/repo ' $HOME; $(not-a-command)");
	config = join(repo, '.devcontainer/selected config/devcontainer.json');
	await mkdir(dirname(config), { recursive: true });
	await writeFile(config, '{}');
	await mkdir(join(repo, '.devcontainer/other'), { recursive: true });
	await writeFile(join(repo, '.devcontainer/other/devcontainer.json'), '{}');
	labels = { 'devcontainer.local_folder': repo, 'devcontainer.config_file': config };
	process.env.VITEST = '1';
	process.env.WORKSPACE_ROOT = root;
	await writeFile(
		join(temporary, 'boundaries.mjs'),
		`const s = globalThis.__dashboardRebuildTests;
export function createPersistentSession(id, command, cwd, options) {
  if (s.spawnError) throw s.spawnError;
  s.spawns.push({ id, command, cwd, options });
  s.exits.set(id, options.onExit);
}
export function deletePersistentSession(id) { s.stops.push(id); return s.stopPromise ?? Promise.resolve(); }
export function isCancelledExit(code, signal) { return [1,2,15].includes(signal) || [129,130,143].includes(code); }
export const RUN_LOG_MAX_CHARS = 10000;
export const RUN_LOG_RETENTION_MS = 86400000;
export async function deleteRunLog(id) { s.deletedLogs.push(id); }
export async function listRunLogs() { return []; }
export async function saveRunLog(metadata, output) { s.logs.push({ metadata, output }); }
export function json(body, init) { return Response.json(body, init); }
export function error(status, message) { throw Object.assign(new Error(message), { status }); }
export function isHttpError(cause) { return Number.isInteger(cause?.status); }
export default {
  getContainer(id) { return {
    async inspect() { s.inspections.push(id); if (s.inspectError) throw s.inspectError; return s.info; },
    async start() { s.actions.push('start'); }, async stop() { s.actions.push('stop'); },
    async restart() { s.actions.push('restart'); }, async remove(options) { s.actions.push(['delete', options]); }
  }; },
  async listContainers(options) { s.lists.push(options); return s.matches; }
};
`
	);
	targets = await sourceModule('src/lib/server/devcontainerRebuild.ts', 'targets.mjs');
	builds = await sourceModule('src/lib/server/devcontainerBuilds.ts', 'builds.mjs', {
		'./devcontainerRebuild.js': './targets.mjs',
		'./terminal.js': './boundaries.mjs',
		'./runLogs.js': './boundaries.mjs'
	});
	actions = await sourceModule(
		'src/routes/api/containers/[id]/[action]/+server.ts',
		'actions.mjs',
		{
			'@sveltejs/kit': './boundaries.mjs',
			'$lib/server/docker': './boundaries.mjs',
			'$lib/server/devcontainerBuilds': './builds.mjs',
			'$lib/server/devcontainerRebuild': './targets.mjs'
		}
	);
	buildRoute = await sourceModule('src/routes/api/devcontainer/build/+server.ts', 'build-route.mjs', {
		'@sveltejs/kit': './boundaries.mjs',
		'$lib/server/devcontainerBuilds': './builds.mjs',
		'$lib/server/devcontainerRebuild': './targets.mjs'
	});
	await writeFile(
		join(temporary, 'terminal-boundaries.mjs'),
		`const s = globalThis.__dashboardRebuildTests;
export function spawn(file, args, options) {
  const child = { pid: 12345, onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; }, write() {}, resize() {} };
  s.ptySpawns.push({ file, args, options, child }); return child;
}
export class WebSocketServer {}
export const WebSocket = { OPEN: 1 };
export function isCookieHeaderAuthenticated() { return true; }
export async function stopTerminalProcess() {}
export function appendOutput(buffer, data) { buffer.push(data); return buffer.join('').length; }
export function terminalLimits() { return { sessions: 100, output: 10000, totalOutput: 100000, viewers: 10 }; }
export function sameOrigin() { return true; }
`
	);
	terminals = await sourceModule('src/lib/server/terminal.ts', 'terminal.mjs', {
		'node-pty': './terminal-boundaries.mjs',
		"'ws'": "'./terminal-boundaries.mjs'",
		'./auth.js': './terminal-boundaries.mjs',
		'./terminalStop.js': './terminal-boundaries.mjs',
		'./terminalPolicy.js': './terminal-boundaries.mjs',
		'./requestPolicy.js': './terminal-boundaries.mjs'
	});
});

/** Reset mocked effects without replacing maps captured by the production modules. */
beforeEach(() => {
	globalThis.__devcontainerBuilds.clear();
	Object.assign(state, {
		spawns: [], stops: [], logs: [], deletedLogs: [], exits: new Map(), ptySpawns: [],
		spawnError: undefined, stopPromise: undefined, inspectError: undefined,
		inspections: [], lists: [], actions: [],
		info: { Id: fullId, Config: { Labels: { ...labels } }, State: { Running: true } },
		matches: [{ Id: fullId }]
	});
});

/** Remove only this test's files and restore environment values changed by the fixture. */
after(async () => {
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	delete globalThis.__dashboardRebuildTests;
	delete globalThis.__devcontainerBuilds;
	delete globalThis.__terminalSessions;
	await rm(temporary, { recursive: true, force: true });
});

/** Construct a request event without bypassing handler input validation. */
function buildRequest(body) {
	return { request: new Request('http://localhost/api/devcontainer/build', {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
	}) };
}

test('resolves the selected named configuration, not another available configuration', async () => {
	const target = await targets.resolveRebuildTarget(root, labels);
	assert.equal(target.repoPath, repo);
	assert.equal(target.configPath, config);
	assert.equal(target.canonicalRepoPath, repo);
});

test('rejects either missing identity label', async () => {
	for (const key of Object.keys(labels)) {
		const incomplete = { ...labels };
		delete incomplete[key];
		await assert.rejects(targets.resolveRebuildTarget(root, incomplete), /requires.*labels/);
	}
});

test('rejects root itself, traversal, prefix collisions, relative paths and control characters', async () => {
	for (const badRepo of [root, join(root, '../outside'), `${root}-other/repo`, 'relative', `${repo}\n`]) {
		await assert.rejects(targets.resolveDevcontainerTarget(root, badRepo, config));
	}
});

test('rejects missing and non-file configurations', async () => {
	await assert.rejects(targets.resolveDevcontainerTarget(root, repo, join(repo, 'missing.json')), /missing/);
	await assert.rejects(targets.resolveDevcontainerTarget(root, repo, dirname(config)), /must be a file/);
});

test('rejects a configuration outside the repository', async () => {
	await assert.rejects(targets.resolveDevcontainerTarget(root, repo, join(root, 'other.json')), /inside/);
});

test('rejects workspace symlink escapes', async () => {
	const outside = join(temporary, 'outside');
	await mkdir(outside);
	await writeFile(join(outside, 'devcontainer.json'), '{}');
	const alias = join(root, 'escape');
	await symlink(outside, alias);
	await assert.rejects(
		targets.resolveDevcontainerTarget(root, alias, join(alias, 'devcontainer.json')), /symlink escapes/
	);
});

test('rejects configuration symlink escapes', async () => {
	const external = join(temporary, 'external.json');
	await writeFile(external, '{}');
	const alias = join(repo, 'escape.json');
	await symlink(external, alias);
	await assert.rejects(targets.resolveDevcontainerTarget(root, repo, alias), /symlink escapes/);
});

test('preserves literal argv, exact labels and cache-enabled recreation', () => {
	const command = targets.devcontainerCommand(repo, config, labels);
	assert.equal(command.file, 'devcontainer');
	assert.deepEqual(command.args, [
		'up', '--workspace-folder', repo, '--config', config,
		'--id-label', `devcontainer.local_folder=${repo}`,
		'--id-label', `devcontainer.config_file=${config}`, '--remove-existing-container'
	]);
	assert.ok(!command.args.includes('--build-no-cache'));
});

test('ordinary build command does not request container removal', () => {
	assert.deepEqual(targets.devcontainerCommand(repo, '.devcontainer/other/devcontainer.json'), {
		file: 'devcontainer', args: ['up', '--workspace-folder', repo, '--config', join(repo, '.devcontainer/other/devcontainer.json')]
	});
});

test('rebuild argv cannot be constructed without exact configuration identity', () => {
	assert.throws(() => targets.devcontainerCommand(repo, undefined, labels), /exact/);
	assert.throws(() => targets.devcontainerCommand(repo, config, {}), /exact/);
});

test('build uses structured persistent PTY options, not a shell command', () => {
	builds.startDevcontainerBuild('build-1', repo, 'fixture', config, labels);
	assert.equal(state.spawns[0].command, undefined);
	assert.deepEqual(state.spawns[0].options.executable, targets.devcontainerCommand(repo, config, labels));
	assert.equal(state.spawns[0].options.kind, 'devcontainer-build');
});

test('serializes builds and rebuilds for the whole canonical repository', async () => {
	const alias = join(root, 'repo-alias');
	await symlink(repo, alias);
	builds.startDevcontainerBuild('first', repo, 'fixture', config, labels);
	assert.throws(() => builds.startDevcontainerBuild('second', alias, 'alias'), builds.DevcontainerBuildConflict);
	assert.equal(state.spawns.length, 1);
});

test('spawn failure clears tracking and releases the lock for retry', () => {
	state.spawnError = new Error('capacity reached');
	assert.throws(() => builds.startDevcontainerBuild('failed-spawn', repo, 'fixture', config), /capacity/);
	assert.deepEqual(builds.getActiveBuilds(), []);
	state.spawnError = undefined;
	assert.equal(builds.startDevcontainerBuild('retry', repo, 'fixture', config).status, 'running');
});

test('successful exit marks completion and permits a later build', () => {
	const build = builds.startDevcontainerBuild('success', repo, 'fixture', config);
	state.exits.get('success')({ exitCode: 0, output: 'done' });
	assert.equal(build.status, 'success');
	assert.equal(builds.startDevcontainerBuild('next', repo, 'fixture', config).status, 'running');
});

test('nonzero exit retains the existing failed-log workflow', () => {
	const build = builds.startDevcontainerBuild('failure', repo, 'fixture', config, labels);
	state.exits.get('failure')({ exitCode: 1, output: 'build failed' });
	assert.equal(build.status, 'failed');
	assert.equal(build.hasLog, true);
	assert.equal(state.logs[0].output, 'build failed');
});

test('cancellation keeps its lock until process-tree termination is verified', async () => {
	let finish;
	state.stopPromise = new Promise((resolve) => { finish = resolve; });
	builds.startDevcontainerBuild('cancel', repo, 'fixture', config);
	const stopped = builds.removeDevcontainerBuild('cancel');
	state.exits.get('cancel')({ exitCode: 143, signal: 15, output: '' });
	assert.throws(() => builds.startDevcontainerBuild('too-early', repo, 'fixture', config), builds.DevcontainerBuildConflict);
	finish();
	await stopped;
	assert.deepEqual(builds.getActiveBuilds(), []);
});

test('rebuild POST accepts running and stopped containers with a unique identity', async () => {
	for (const running of [true, false]) {
		globalThis.__devcontainerBuilds.clear();
		state.info.State.Running = running;
		const response = await actions.POST({ params: { id: fullId.slice(0, 12), action: 'rebuild' } });
		assert.equal(response.status, 202);
		const body = await response.json();
		assert.equal(body.repoPath, repo);
		assert.equal(body.repoName, repo.split('/').at(-1));
		assert.ok(body.id);
	}
	assert.deepEqual(state.lists[0].filters.label, [
		`devcontainer.local_folder=${repo}`, `devcontainer.config_file=${config}`
	]);
});

test('rebuild POST rejects missing labels before spawning or listing identities', async () => {
	state.info.Config.Labels = {};
	await assert.rejects(actions.POST({ params: { id: fullId, action: 'rebuild' } }), { status: 400 });
	assert.equal(state.spawns.length, 0);
	assert.equal(state.lists.length, 0);
});

test('rebuild POST rejects stale, ambiguous and changed container identities', async () => {
	for (const matches of [[], [{ Id: fullId }, { Id: 'b'.repeat(64) }], [{ Id: 'b'.repeat(64) }]]) {
		state.matches = matches;
		await assert.rejects(actions.POST({ params: { id: fullId, action: 'rebuild' } }), { status: 409 });
	}
	assert.equal(state.spawns.length, 0);
});

test('rebuild POST reports failed inspection without starting work', async () => {
	state.inspectError = new Error('not found');
	await assert.rejects(actions.POST({ params: { id: fullId, action: 'rebuild' } }), { status: 404 });
	assert.equal(state.spawns.length, 0);
});

test('rebuild POST exposes spawn failure without leaving a running build', async () => {
	state.spawnError = new Error('PTY capacity reached');
	await assert.rejects(actions.POST({ params: { id: fullId, action: 'rebuild' } }), {
		status: 503,
		message: /terminal capacity/
	});
	assert.deepEqual(builds.getActiveBuilds(), []);
});

test('concurrent rebuild POSTs start exactly one process', async () => {
	const event = { params: { id: fullId, action: 'rebuild' } };
	const results = await Promise.allSettled([actions.POST(event), actions.POST(event)]);
	assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
	assert.equal(results.find((entry) => entry.status === 'rejected').reason.status, 409);
	assert.equal(state.spawns.length, 1);
});

test('status polling uses build identity without inspecting the removed container', async () => {
	builds.startDevcontainerBuild('poll', repo, 'fixture', config);
	state.inspectError = new Error('old container removed');
	const response = await actions.GET({
		params: { id: fullId, action: 'rebuild' },
		url: new URL('http://localhost/status?sessionId=poll')
	});
	assert.equal((await response.json()).status, 'running');
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.deepEqual(state.inspections, []);
});

test('unknown/cancelled build status never reports success', async () => {
	await assert.rejects(actions.GET({
		params: { action: 'rebuild' }, url: new URL('http://localhost/status?sessionId=unknown')
	}), { status: 404 });
});

test('existing Docker lifecycle actions retain their original operations', async () => {
	for (const action of ['start', 'stop', 'restart', 'delete']) {
		const response = await actions.POST({ params: { id: fullId, action } });
		assert.equal(response.status, 200);
	}
	assert.deepEqual(state.actions, ['start', 'stop', 'restart', ['delete', { force: true, v: true }]]);
});

test('ordinary build endpoint shares rebuild validation and conflicts', async () => {
	const body = { repoPath: repo, repoName: 'fixture', configPath: '.devcontainer/selected config/devcontainer.json' };
	assert.equal((await buildRoute.POST(buildRequest(body))).status, 200);
	await assert.rejects(buildRoute.POST(buildRequest(body)), { status: 409 });
	assert.equal(state.spawns.length, 1);
});

test('ordinary build endpoint rejects traversal and invalid JSON field types', async () => {
	for (const body of [
		{ repoPath: repo, repoName: 'fixture', configPath: '../../outside.json' },
		{ repoPath: repo, repoName: 'fixture', configPath: 42 },
		{ repoPath: 42, repoName: 'fixture' }
	]) {
		await assert.rejects(buildRoute.POST(buildRequest(body)), { status: 400 });
	}
	assert.equal(state.spawns.length, 0);
});

test('structured terminal spawn preserves argv and filters only the existing excluded environment', () => {
	const previous = {
		DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD,
		DDASH_TEST_LOCAL_ENV: process.env.DDASH_TEST_LOCAL_ENV
	};
	try {
		process.env.DASHBOARD_PASSWORD = 'never-forward';
		process.env.DDASH_TEST_LOCAL_ENV = 'fixture-value';
		const command = targets.devcontainerCommand(repo, config, labels);
		terminals.createPersistentSession('literal-argv', undefined, repo, {
			executable: command, kind: 'devcontainer-build'
		});
		const spawn = state.ptySpawns[0];
		assert.equal(spawn.file, 'devcontainer');
		assert.deepEqual(spawn.args, command.args);
		assert.equal(spawn.options.env.DASHBOARD_PASSWORD, undefined);
		assert.equal(spawn.options.env.DDASH_TEST_LOCAL_ENV, 'fixture-value');
		spawn.child.exit({ exitCode: 0 });
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test('arbitrary operator terminal commands keep their existing bash semantics', () => {
	terminals.createPersistentSession('operator-shell', 'printf hello', repo);
	const spawn = state.ptySpawns[0];
	assert.equal(spawn.file, '/bin/bash');
	assert.deepEqual(spawn.args, ['-c', 'printf hello']);
	spawn.child.exit({ exitCode: 0 });
});
