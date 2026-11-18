/**
 * Source regressions for Compose sandbox discovery, validation, argv, inspection, run
 * tracking, and HTTP contracts.
 * Run with Node 22.13+: node --experimental-strip-types --test scripts/tests/compose-sandbox.test.mjs
 * Production TypeScript is stripped into a temporary module graph. Only Docker, the Compose
 * CLI, PTY, logs, and SvelteKit response boundaries are mocked. No Docker is required.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const previousEnv = { VITEST: process.env.VITEST, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT };
const state = (globalThis.__dashboardComposeTests = {});
let temporary;
let root;
let repo;
let commands;
let sandbox;
let runs;
let inspectRoute;
let runRoute;

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

/** Write one fixture file, creating its directory. */
async function fixture(path, content = 'services: {}\n') {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

/** Build a workspace with shell-significant characters and every discovery edge case. */
before(async () => {
	temporary = await mkdtemp(join(tmpdir(), 'ddash-compose-'));
	root = join(temporary, 'workspace');
	repo = join(root, "task/solution ' $HOME; $(not-a-command)");
	for (const file of [
		'docker-compose.yml',
		'docker-compose.override.yml',
		'compose.sandbox.yaml',
		'sandbox/compose.yaml',
		'.devcontainer/docker-compose.yml',
		'node_modules/compose.yml',
		'deep/er/compose.yaml',
		'notes.yaml'
	])
		await fixture(join(repo, file));
	await fixture(join(repo, '.env.sandbox'), 'TAG=1\n');
	await fixture(join(temporary, 'outside/compose.yaml'));
	await symlink(join(temporary, 'outside/compose.yaml'), join(repo, 'escape/compose.yaml')).catch(
		async () => {
			await mkdir(join(repo, 'escape'), { recursive: true });
			await symlink(join(temporary, 'outside/compose.yaml'), join(repo, 'escape/compose.yaml'));
		}
	);
	await symlink(join(temporary, 'outside'), join(root, 'task/linked-repo'));
	process.env.VITEST = '1';
	process.env.WORKSPACE_ROOT = root;
	await writeFile(
		join(temporary, 'boundaries.mjs'),
		`const s = globalThis.__dashboardComposeTests;
export function execFile(file, args, options, callback) {
  s.configCalls.push({ file, args, options });
  const result = s.configResult;
  queueMicrotask(() => {
    if (result.error) callback(Object.assign(new Error('failed'), result.error), '', result.stderr ?? '');
    else callback(null, result.stdout, result.stderr ?? '');
  });
}
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
export default {
  async listContainers(options) { s.lists.push(options); return s.containers; }
};
`
	);
	commands = await sourceModule('src/lib/composeCommands.ts', 'commands.mjs');
	sandbox = await sourceModule('src/lib/server/composeSandbox.ts', 'sandbox.mjs', {
		'node:child_process': './boundaries.mjs',
		'../composeCommands.js': './commands.mjs'
	});
	runs = await sourceModule('src/lib/server/composeRuns.ts', 'runs.mjs', {
		'../composeCommands.js': './commands.mjs',
		'./terminal.js': './boundaries.mjs',
		'./runLogs.js': './boundaries.mjs'
	});
	const routeReplacements = {
		'@sveltejs/kit': './boundaries.mjs',
		'$lib/server/docker': './boundaries.mjs',
		'$lib/server/composeSandbox': './sandbox.mjs'
	};
	inspectRoute = await sourceModule(
		'src/routes/api/compose/+server.ts',
		'inspect-route.mjs',
		routeReplacements
	);
	runRoute = await sourceModule('src/routes/api/compose/run/+server.ts', 'run-route.mjs', {
		...routeReplacements,
		'$lib/composeCommands': './commands.mjs',
		'$lib/server/composeRuns': './runs.mjs'
	});
});

/** Resolved Compose JSON with values that must never reach a response. */
function resolvedConfig(name = 'keflavik') {
	return JSON.stringify({
		name,
		services: {
			fdp: {
				image: 'registry.example/fdp:1',
				environment: { DB_PASSWORD: 'never-return-this' },
				secrets: ['db'],
				ports: [{ target: 8080, published: '18080', protocol: 'tcp', host_ip: '127.0.0.1' }],
				networks: { oplan: { ipv4_address: '192.168.103.10' } },
				profiles: ['sim'],
				container_name: 'keflavik-fdp'
			},
			builder: { build: { context: '.', args: { TOKEN: 'never-return-this' } }, networks: ['oplan'] }
		},
		networks: {
			oplan: { name: 'keflavik_oplan', ipam: { config: [{ subnet: '192.168.103.0/24' }] } },
			shared: { name: 'shared', external: true }
		},
		secrets: { db: { file: '/secret/path' } }
	});
}

/** Reset mocked effects without replacing maps captured by the production modules. */
beforeEach(() => {
	globalThis.__composeRuns?.clear();
	Object.assign(state, {
		configCalls: [],
		configResult: { stdout: resolvedConfig(), stderr: '' },
		containers: [],
		lists: [],
		spawns: [],
		stops: [],
		logs: [],
		deletedLogs: [],
		exits: new Map(),
		spawnError: undefined,
		stopPromise: undefined
	});
});

/** Remove only this test's files and restore environment values changed by the fixture. */
after(async () => {
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	delete globalThis.__dashboardComposeTests;
	delete globalThis.__composeRuns;
	await rm(temporary, { recursive: true, force: true });
});

/** A valid selection for the fixture repository. */
function input(overrides = {}) {
	return {
		repoPath: repo,
		files: ['docker-compose.yml', 'docker-compose.override.yml'],
		envFile: '.env.sandbox',
		profiles: ['sim'],
		...overrides
	};
}

/** Construct a JSON request event without bypassing handler validation. */
function postEvent(body) {
	return {
		request: new Request('http://localhost/api/compose/run', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		})
	};
}

test('discovers root and first-level files; skips hidden, dependency, deep and non-Compose files', async () => {
	const files = await sandbox.findComposeFiles(repo);
	assert.deepEqual(files, [
		'docker-compose.yml',
		'docker-compose.override.yml',
		'compose.sandbox.yaml',
		'escape/compose.yaml',
		'sandbox/compose.yaml'
	]);
	assert.deepEqual(await sandbox.findComposeFiles(join(temporary, 'missing')), []);
});

test('default selection is the Compose default file plus its own override', () => {
	const files = ['docker-compose.yml', 'docker-compose.override.yml', 'compose.sandbox.yaml'];
	assert.deepEqual(commands.defaultComposeSelection(files), [
		'docker-compose.yml',
		'docker-compose.override.yml'
	]);
	assert.deepEqual(commands.defaultComposeSelection(['compose.sandbox.yaml']), [
		'compose.sandbox.yaml'
	]);
	assert.deepEqual(commands.defaultComposeSelection(files, 'sandbox'), []);
});

test('resolves a valid selection to lexical and canonical project paths', async () => {
	const target = await sandbox.resolveComposeTarget(root, input());
	assert.equal(target.repoPath, repo);
	assert.equal(target.projectDirectory, repo);
	assert.equal(target.canonicalProjectDirectory, repo);
	assert.deepEqual(target.selection, {
		files: ['docker-compose.yml', 'docker-compose.override.yml'],
		profiles: ['sim'],
		envFile: '.env.sandbox'
	});
	const nested = await sandbox.resolveComposeTarget(root, input({ files: ['sandbox/compose.yaml'] }));
	assert.equal(nested.projectDirectory, join(repo, 'sandbox'));
});

test('rejects unsafe or ambiguous selections before any process starts', async () => {
	const invalid = [
		input({ repoPath: 'relative' }),
		input({ repoPath: root }),
		input({ repoPath: `${root}-other/repo` }),
		input({ repoPath: join(root, '../outside') }),
		input({ repoPath: `${repo}\n` }),
		input({ files: [] }),
		input({ files: 'docker-compose.yml' }),
		input({ files: ['../outside/compose.yaml'] }),
		input({ files: ['./docker-compose.yml'] }),
		input({ files: [join(repo, 'docker-compose.yml')] }),
		input({ files: ['notes.yaml'] }),
		input({ files: ['docker-compose.yml', 'docker-compose.yml'] }),
		input({ files: ['docker-compose.yml', 'sandbox/compose.yaml'] }),
		input({ files: ['deep/er/compose.yaml'] }),
		input({ files: ['missing/compose.yaml'] }),
		input({ files: Array.from({ length: 9 }, (_, i) => `compose.${i}.yaml`) }),
		input({ envFile: '../.env' }),
		input({ envFile: 'missing.env' }),
		input({ profiles: ['--rm'] }),
		input({ profiles: 'sim' })
	];
	for (const selection of invalid) {
		await assert.rejects(sandbox.resolveComposeTarget(root, selection), sandbox.ComposeTargetError);
	}
	assert.equal(state.configCalls.length, 0);
});

test('rejects Compose file and repository symlink escapes', async () => {
	await assert.rejects(
		sandbox.resolveComposeTarget(root, input({ files: ['escape/compose.yaml'] })),
		/symlink escapes/
	);
	await assert.rejects(
		sandbox.resolveComposeTarget(
			root,
			input({ repoPath: join(root, 'task/linked-repo'), files: ['compose.yaml'], envFile: '' })
		),
		/symlink escapes/
	);
});

test('builds literal argv for every allowlisted action, without down or volume removal', async () => {
	const { selection } = await sandbox.resolveComposeTarget(root, input());
	const global = [
		'compose',
		'--project-directory',
		repo,
		'--file',
		join(repo, 'docker-compose.yml'),
		'--file',
		join(repo, 'docker-compose.override.yml'),
		'--env-file',
		join(repo, '.env.sandbox'),
		'--profile',
		'sim'
	];
	const expected = {
		build: ['build'],
		up: ['up', '--detach'],
		'up-build': ['up', '--detach', '--build'],
		stop: ['stop']
	};
	assert.deepEqual([...commands.COMPOSE_ACTIONS], Object.keys(expected));
	for (const [action, tail] of Object.entries(expected)) {
		assert.deepEqual(commands.composeActionCommand(repo, selection, action), {
			file: 'docker',
			args: [...global, ...tail]
		});
	}
	assert.equal(commands.isComposeAction('down'), false);
	assert.equal(commands.isComposeAction('rm'), false);
});

test('displayed shell commands round-trip through bash unchanged', async () => {
	const { selection } = await sandbox.resolveComposeTarget(root, input());
	const command = commands.composeLogsCommand(repo, selection);
	const printed = execFileSync('bash', [
		'-c',
		`printf '%s\\n' ${commands.shellCommand(command).replace(/^docker /, '')}`
	]).toString();
	assert.deepEqual(printed.trimEnd().split('\n'), command.args);
});

test('inspection runs config with literal argv and a filtered environment', async () => {
	const previous = process.env.DASHBOARD_PASSWORD;
	process.env.DASHBOARD_PASSWORD = 'never-forward';
	try {
		const target = await sandbox.resolveComposeTarget(root, input());
		await sandbox.inspectComposeTarget(target, async () => []);
		const call = state.configCalls[0];
		assert.equal(call.file, 'docker');
		assert.deepEqual(call.args.slice(-3), ['config', '--format', 'json']);
		assert.equal(call.options.cwd, repo);
		assert.equal(call.options.env.DASHBOARD_PASSWORD, undefined);
		assert.ok(call.options.timeout > 0);
	} finally {
		if (previous === undefined) delete process.env.DASHBOARD_PASSWORD;
		else process.env.DASHBOARD_PASSWORD = previous;
	}
});

test('inspection returns structure only, never environment, build arguments or secrets', async () => {
	state.configResult = {
		stdout: resolvedConfig(),
		stderr: 'time="x" level=warning msg="The \\"TAG\\" variable is not set. Defaulting to a blank string."\nPulling\n'
	};
	const target = await sandbox.resolveComposeTarget(root, input());
	const inspection = await sandbox.inspectComposeTarget(target, async (options) => {
		state.lists.push(options);
		return [];
	});
	assert.equal(inspection.projectName, 'keflavik');
	assert.deepEqual(state.lists[0], {
		all: true,
		filters: { label: ['com.docker.compose.project=keflavik'] }
	});
	assert.deepEqual(inspection.services[1], {
		name: 'fdp',
		image: 'registry.example/fdp:1',
		hasBuild: false,
		profiles: ['sim'],
		ports: [{ target: '8080', published: '18080', protocol: 'tcp', hostIp: '127.0.0.1' }],
		networks: ['oplan'],
		containerName: 'keflavik-fdp'
	});
	assert.equal(inspection.services[0].hasBuild, true);
	assert.deepEqual(inspection.networks, [
		{ key: 'oplan', name: 'keflavik_oplan', external: false, subnet: '192.168.103.0/24' },
		{ key: 'shared', name: 'shared', external: true }
	]);
	assert.equal(inspection.warnings.length, 1);
	assert.equal(inspection.ownership, 'none');
	const serialized = JSON.stringify(inspection);
	assert.ok(!serialized.includes('never-return-this'));
	assert.ok(!serialized.includes('/secret/path'));
});

test('classifies stack ownership by Compose working directory', () => {
	const container = (workingDir, state = 'running') => ({
		Id: 'a'.repeat(64),
		Names: ['/keflavik-fdp-1'],
		State: state,
		Labels: {
			'com.docker.compose.service': 'fdp',
			...(workingDir ? { 'com.docker.compose.project.working_dir': workingDir } : {})
		}
	});
	assert.equal(sandbox.classifyStack([], [repo]).ownership, 'none');
	const mine = sandbox.classifyStack([container(`${repo}/`, 'exited')], [repo]);
	assert.equal(mine.ownership, 'this');
	assert.deepEqual(mine.containers[0], {
		id: 'a'.repeat(12),
		name: 'keflavik-fdp-1',
		service: 'fdp',
		state: 'exited',
		workingDir: `${repo}/`
	});
	const other = sandbox.classifyStack([container(repo), container('/elsewhere')], [repo]);
	assert.equal(other.ownership, 'other');
	assert.deepEqual(other.otherWorkingDirs, ['/elsewhere']);
	assert.equal(sandbox.classifyStack([container(undefined)], [repo]).ownership, 'other');
});

test('maps missing CLI, rejected configuration and unreadable output to distinct errors', async () => {
	const target = await sandbox.resolveComposeTarget(root, input());
	state.configResult = { error: { code: 'ENOENT' } };
	await assert.rejects(sandbox.inspectComposeTarget(target, async () => []), sandbox.ComposeUnavailableError);
	state.configResult = { error: { code: 1 }, stderr: "docker: 'compose' is not a docker command." };
	await assert.rejects(sandbox.inspectComposeTarget(target, async () => []), sandbox.ComposeUnavailableError);
	state.configResult = { error: { code: 1 }, stderr: 'required variable TAG is missing a value' };
	await assert.rejects(sandbox.inspectComposeTarget(target, async () => []), /TAG is missing/);
	state.configResult = { stdout: 'not json' };
	await assert.rejects(sandbox.inspectComposeTarget(target, async () => []), /unreadable/);
});

test('run uses a structured persistent PTY in the project directory', async () => {
	const target = await sandbox.resolveComposeTarget(root, input());
	const run = runs.startComposeRun('run-1', target, 'solution', 'keflavik', 'up-build');
	assert.equal(run.status, 'running');
	const spawn = state.spawns[0];
	assert.equal(spawn.command, undefined);
	assert.equal(spawn.cwd, repo);
	assert.equal(spawn.options.kind, 'compose');
	assert.deepEqual(
		spawn.options.executable,
		commands.composeActionCommand(repo, target.selection, 'up-build')
	);
});

test('serializes operations by canonical project directory and by project name', async () => {
	const target = await sandbox.resolveComposeTarget(root, input());
	const nested = await sandbox.resolveComposeTarget(root, input({ files: ['sandbox/compose.yaml'] }));
	runs.startComposeRun('first', target, 'solution', 'keflavik', 'build');
	assert.throws(
		() => runs.startComposeRun('same-dir', target, 'solution', 'other', 'up'),
		runs.ComposeRunConflict
	);
	assert.throws(
		() => runs.startComposeRun('same-name', nested, 'solution', 'keflavik', 'up'),
		runs.ComposeRunConflict
	);
	assert.equal(runs.startComposeRun('independent', nested, 'solution', 'sandbox', 'up').status, 'running');
	assert.equal(state.spawns.length, 2);
});

test('spawn failure releases the lock; failed exit keeps a Compose log', async () => {
	const target = await sandbox.resolveComposeTarget(root, input());
	state.spawnError = new Error('capacity');
	assert.throws(() => runs.startComposeRun('broken', target, 'solution', 'keflavik', 'up'), /capacity/);
	assert.deepEqual(runs.getActiveComposeRuns(), []);
	state.spawnError = undefined;
	const run = runs.startComposeRun('failing', target, 'solution', 'keflavik', 'up');
	state.exits.get('failing')({ exitCode: 1, output: 'port is already allocated' });
	assert.equal(run.status, 'failed');
	assert.equal(state.logs[0].metadata.kind, 'compose');
	assert.equal(state.logs[0].metadata.action, 'up');
	assert.deepEqual(state.logs[0].metadata.files, target.selection.files);
	assert.equal(runs.startComposeRun('retry', target, 'solution', 'keflavik', 'up').status, 'running');
});

test('cancellation holds the lock until process-tree termination is verified', async () => {
	const target = await sandbox.resolveComposeTarget(root, input());
	let finish;
	state.stopPromise = new Promise((resolve) => {
		finish = resolve;
	});
	runs.startComposeRun('cancel', target, 'solution', 'keflavik', 'up');
	const stopped = runs.removeComposeRun('cancel');
	state.exits.get('cancel')({ exitCode: 143, signal: 15, output: '' });
	assert.throws(
		() => runs.startComposeRun('early', target, 'solution', 'keflavik', 'up'),
		runs.ComposeRunConflict
	);
	finish();
	await stopped;
	assert.deepEqual(runs.getActiveComposeRuns(), []);
});

test('inspect GET reads repeated file and profile parameters', async () => {
	const url = new URL('http://localhost/api/compose');
	url.searchParams.set('repoPath', repo);
	url.searchParams.append('file', 'docker-compose.yml');
	url.searchParams.append('file', 'docker-compose.override.yml');
	url.searchParams.append('profile', 'sim');
	const response = await inspectRoute.GET({ url });
	assert.equal(response.headers.get('cache-control'), 'no-store');
	const body = await response.json();
	assert.equal(body.projectName, 'keflavik');
	assert.deepEqual(body.selection.files, ['docker-compose.yml', 'docker-compose.override.yml']);
	url.searchParams.append('file', '../x/compose.yaml');
	await assert.rejects(inspectRoute.GET({ url }), { status: 400 });
});

test('run POST rejects unknown actions and invalid selections without spawning', async () => {
	for (const body of [
		{ ...input(), repoName: 'solution', action: 'down' },
		{ ...input(), repoName: 'solution', action: 'up; rm -rf /' },
		{ ...input({ files: ['../x/compose.yaml'] }), repoName: 'solution', action: 'up' },
		{ ...input(), repoName: '', action: 'up' }
	]) {
		await assert.rejects(runRoute.POST(postEvent(body)), { status: 400 });
	}
	assert.equal(state.spawns.length, 0);
});

test('run POST refuses a project name owned by another working directory', async () => {
	state.containers = [
		{
			Id: 'b'.repeat(64),
			Names: ['/keflavik-fdp-1'],
			State: 'running',
			Labels: { 'com.docker.compose.project.working_dir': '/home/other/task/solution' }
		}
	];
	await assert.rejects(runRoute.POST(postEvent({ ...input(), repoName: 'solution', action: 'up' })), {
		status: 409,
		message: /\/home\/other\/task\/solution/
	});
	assert.equal(state.spawns.length, 0);
});

test('run POST reports configuration errors as 422 and a missing CLI as 503', async () => {
	state.configResult = { error: { code: 1 }, stderr: 'services.fdp.image must be a string' };
	await assert.rejects(runRoute.POST(postEvent({ ...input(), repoName: 'solution', action: 'up' })), {
		status: 422
	});
	state.configResult = { error: { code: 'ENOENT' } };
	await assert.rejects(runRoute.POST(postEvent({ ...input(), repoName: 'solution', action: 'up' })), {
		status: 503
	});
	assert.equal(state.spawns.length, 0);
});

test('concurrent run POSTs for one sandbox start exactly one process', async () => {
	const body = { ...input(), repoName: 'solution', action: 'up-build' };
	const results = await Promise.allSettled([
		runRoute.POST(postEvent(body)),
		runRoute.POST(postEvent(body))
	]);
	assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
	assert.equal(results.find((entry) => entry.status === 'rejected').reason.status, 409);
	assert.equal(state.spawns.length, 1);
	const accepted = await results.find((entry) => entry.status === 'fulfilled').value.json();
	assert.equal(accepted.projectName, 'keflavik');
});
