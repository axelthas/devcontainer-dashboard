/**
 * Source regressions for Compose sandbox discovery, validation, argv, inspection, run
 * tracking, sandbox versions, registry tag listing, sandbox removal, and HTTP contracts.
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
const previousEnv = {
	VITEST: process.env.VITEST,
	WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
	COMPOSE_OVERRIDE_DIR: process.env.COMPOSE_OVERRIDE_DIR,
	DOCKER_CONFIG: process.env.DOCKER_CONFIG
};
const state = (globalThis.__dashboardComposeTests = {});
let temporary;
let root;
let repo;
let commands;
let sandbox;
let kindDescriptor;
let composeKinds;
let instancePlan;
let runs;
let inspectRoute;
let runRoute;
let image;
let registry;
let removal;
let tagsRoute;
let removeRoute;

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
	process.env.COMPOSE_OVERRIDE_DIR = join(temporary, 'overrides');
	process.env.DOCKER_CONFIG = join(temporary, 'docker-config');
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
  async listContainers(options) { s.lists.push(options); return s.containers; },
  getImage(name) {
    return { async inspect() {
      if (s.missingImages.includes(name)) throw Object.assign(new Error('No such image'), { statusCode: 404 });
      return { RepoDigests: [name.split(':')[0] + '@sha256:' + 'a'.repeat(64)] };
    } };
  }
};
`
	);
	commands = await sourceModule('src/lib/composeCommands.ts', 'commands.mjs');
	image = await sourceModule('src/lib/imageReference.ts', 'image.mjs');
	kindDescriptor = await sourceModule('src/lib/server/kindDescriptor.ts', 'kind-descriptor.mjs');
	composeKinds = await sourceModule('src/lib/server/composeKinds.ts', 'compose-kinds.mjs', {
		'../imageReference.js': './image.mjs',
		'./kindDescriptor.js': './kind-descriptor.mjs'
	});
	await sourceModule('src/lib/server/composeInstanceAddresses.ts', 'instance-addresses.mjs');
	instancePlan = await sourceModule('src/lib/server/composeInstancePlan.ts', 'instance-plan.mjs', {
		'./composeInstanceAddresses.js': './instance-addresses.mjs'
	});
	sandbox = await sourceModule('src/lib/server/composeSandbox.ts', 'sandbox.mjs', {
		'./composeKinds.js': './compose-kinds.mjs',
		'./kindDescriptor.js': './kind-descriptor.mjs',
		'node:child_process': './boundaries.mjs',
		'../composeCommands.js': './commands.mjs',
		'../imageReference.js': './image.mjs'
	});
	await sourceModule('src/lib/server/composeImages.ts', 'images.mjs');
	runs = await sourceModule('src/lib/server/composeRuns.ts', 'runs.mjs', {
		'../composeCommands.js': './commands.mjs',
		'./terminal.js': './boundaries.mjs',
		'./runLogs.js': './boundaries.mjs'
	});
	registry = await sourceModule('src/lib/server/registryTags.ts', 'registry.mjs');
	removal = await sourceModule('src/lib/server/composeRemoval.ts', 'removal.mjs', {
		'../imageReference.js': './image.mjs',
		'./composeRuns.js': './runs.mjs'
	});
	const routeReplacements = {
		'@sveltejs/kit': './boundaries.mjs',
		'$lib/server/docker': './boundaries.mjs',
		'$lib/server/composeSandbox': './sandbox.mjs',
		'$lib/server/composeImages': './images.mjs'
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
	tagsRoute = await sourceModule('src/routes/api/compose/tags/+server.ts', 'tags-route.mjs', {
		'@sveltejs/kit': './boundaries.mjs',
		'$lib/server/docker': './boundaries.mjs',
		'$lib/server/composeSandbox': './sandbox.mjs',
		'$lib/imageReference': './image.mjs',
		'$lib/server/registryTags': './registry.mjs'
	});
	removeRoute = await sourceModule('src/routes/api/compose/remove/+server.ts', 'remove-route.mjs', {
		'@sveltejs/kit': './boundaries.mjs',
		'$lib/server/docker': './boundaries.mjs',
		'$lib/server/composeRemoval': './removal.mjs',
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
				container_name: 'keflavik-fdp',
				depends_on: { builder: { condition: 'service_started', required: true } }
			},
			builder: {
				build: { context: '.', args: { TOKEN: 'never-return-this' } },
				networks: ['oplan']
			}
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
		stopPromise: undefined,
		missingImages: []
	});
	globalThis.__composeRemovals?.clear();
	registry?.clearRegistryTagCache();
});

/** Remove only this test's files and restore environment values changed by the fixture. */
after(async () => {
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	delete globalThis.__dashboardComposeTests;
	delete globalThis.__composeRuns;
	delete globalThis.__composeRemovals;
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
	const nested = await sandbox.resolveComposeTarget(
		root,
		input({ files: ['sandbox/compose.yaml'] })
	);
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
		up: ['up', '--detach', '--pull', 'never'],
		'up-build': ['up', '--detach', '--build'],
		stop: ['stop'],
		pull: ['pull', '--ignore-buildable'],
		'up-pull': ['pull', '--ignore-buildable']
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
		stderr:
			'time="x" level=warning msg="The \\"TAG\\" variable is not set. Defaulting to a blank string."\nPulling\n'
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
		source: 'registry',
		profiles: ['sim'],
		ports: [{ target: '8080', published: '18080', protocol: 'tcp', hostIp: '127.0.0.1' }],
		networks: ['oplan'],
		dependsOn: ['builder'],
		containerName: 'keflavik-fdp'
	});
	assert.deepEqual(inspection.services[0].dependsOn, []);
	assert.equal(inspection.services[0].hasBuild, true);
	assert.equal(inspection.services[0].source, 'build');
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
	await assert.rejects(
		sandbox.inspectComposeTarget(target, async () => []),
		sandbox.ComposeUnavailableError
	);
	state.configResult = { error: { code: 1 }, stderr: "docker: 'compose' is not a docker command." };
	await assert.rejects(
		sandbox.inspectComposeTarget(target, async () => []),
		sandbox.ComposeUnavailableError
	);
	state.configResult = { error: { code: 1 }, stderr: 'required variable TAG is missing a value' };
	await assert.rejects(
		sandbox.inspectComposeTarget(target, async () => []),
		/TAG is missing/
	);
	state.configResult = { stdout: 'not json' };
	await assert.rejects(
		sandbox.inspectComposeTarget(target, async () => []),
		/unreadable/
	);
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
	const nested = await sandbox.resolveComposeTarget(
		root,
		input({ files: ['sandbox/compose.yaml'] })
	);
	runs.startComposeRun('first', target, 'solution', 'keflavik', 'build');
	assert.throws(
		() => runs.startComposeRun('same-dir', target, 'solution', 'other', 'up'),
		runs.ComposeRunConflict
	);
	assert.throws(
		() => runs.startComposeRun('same-name', nested, 'solution', 'keflavik', 'up'),
		runs.ComposeRunConflict
	);
	assert.equal(
		runs.startComposeRun('independent', nested, 'solution', 'sandbox', 'up').status,
		'running'
	);
	assert.equal(state.spawns.length, 2);
});

test('spawn failure releases the lock; failed exit keeps a Compose log', async () => {
	const target = await sandbox.resolveComposeTarget(root, input());
	state.spawnError = new Error('capacity');
	assert.throws(
		() => runs.startComposeRun('broken', target, 'solution', 'keflavik', 'up'),
		/capacity/
	);
	assert.deepEqual(runs.getActiveComposeRuns(), []);
	state.spawnError = undefined;
	const run = runs.startComposeRun('failing', target, 'solution', 'keflavik', 'up');
	state.exits.get('failing')({ exitCode: 1, output: 'port is already allocated' });
	assert.equal(run.status, 'failed');
	assert.equal(state.logs[0].metadata.kind, 'compose');
	assert.equal(state.logs[0].metadata.action, 'up');
	assert.deepEqual(state.logs[0].metadata.files, target.selection.files);
	assert.equal(
		runs.startComposeRun('retry', target, 'solution', 'keflavik', 'up').status,
		'running'
	);
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
	await assert.rejects(
		runRoute.POST(postEvent({ ...input(), repoName: 'solution', action: 'up' })),
		{
			status: 409,
			message: /\/home\/other\/task\/solution/
		}
	);
	assert.equal(state.spawns.length, 0);
});

test('run POST reports configuration errors as 422 and a missing CLI as 503', async () => {
	state.configResult = { error: { code: 1 }, stderr: 'services.fdp.image must be a string' };
	await assert.rejects(
		runRoute.POST(postEvent({ ...input(), repoName: 'solution', action: 'up' })),
		{
			status: 422
		}
	);
	state.configResult = { error: { code: 'ENOENT' } };
	await assert.rejects(
		runRoute.POST(postEvent({ ...input(), repoName: 'solution', action: 'up' })),
		{
			status: 503
		}
	);
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

test('appends selected services to every action and to the log command', async () => {
	const { selection } = await sandbox.resolveComposeTarget(root, input());
	for (const action of commands.COMPOSE_ACTIONS) {
		const command = commands.composeActionCommand(repo, selection, action, ['fdp', 'db']);
		assert.deepEqual(command.args.slice(-2), ['fdp', 'db']);
	}
	const logs = commands.composeLogsCommand(repo, selection, ['fdp']);
	assert.deepEqual(logs.args.slice(-5), ['logs', '--follow', '--tail', '200', 'fdp']);
	assert.deepEqual(
		commands.composeActionCommand(repo, selection, 'up'),
		commands.composeActionCommand(repo, selection, 'up', [])
	);
});

test('adds transitive dependencies in config order and survives cycles', () => {
	const services = [
		{ name: 'db', dependsOn: [] },
		{ name: 'fdp', dependsOn: ['db', 'missing'] },
		{ name: 'hmi', dependsOn: ['fdp'] },
		{ name: 'a', dependsOn: ['b'] },
		{ name: 'b', dependsOn: ['a'] }
	];
	assert.deepEqual(commands.withDependencies(services, ['hmi']), ['db', 'fdp', 'hmi']);
	assert.deepEqual(commands.withDependencies(services, ['a']), ['a', 'b']);
	assert.deepEqual(commands.withDependencies(services, []), []);
});

test('sandbox kind ignores the task workspace path', () => {
	const files = ['docker-compose.yml', 'docker-compose.override.yml'];
	const kind = commands.composeSandboxKind('solution', files);
	assert.equal(kind, commands.composeSandboxKind('solution', [...files]));
	assert.notEqual(kind, commands.composeSandboxKind('solution', ['docker-compose.yml']));
	assert.notEqual(kind, commands.composeSandboxKind('other-solution', files));
});

test('reports depends_on in map and list form', () => {
	const summary = sandbox.summarizeComposeConfig({
		name: 'x',
		services: { a: { depends_on: ['b'] }, b: {}, c: { depends_on: { a: { required: true } } } }
	});
	assert.deepEqual(
		summary.services.map((service) => service.dependsOn),
		[['b'], [], ['a']]
	);
});

test('validates a service subset against the resolved services', () => {
	const available = ['builder', 'fdp', 'hmi'];
	assert.deepEqual(sandbox.resolveComposeServices(undefined, available), []);
	assert.deepEqual(sandbox.resolveComposeServices(['hmi', 'fdp', 'builder'], available), []);
	assert.deepEqual(sandbox.resolveComposeServices(['hmi', 'fdp', 'hmi'], available), [
		'fdp',
		'hmi'
	]);
	for (const value of [[], 'fdp', ['unknown'], ['--rm'], [7], Array(129).fill('fdp')]) {
		assert.throws(
			() => sandbox.resolveComposeServices(value, available),
			sandbox.ComposeTargetError
		);
	}
});

test('run POST passes a validated service subset and records it', async () => {
	const body = { ...input(), repoName: 'solution', action: 'up', services: ['fdp'] };
	await runRoute.POST(postEvent(body));
	assert.deepEqual(state.spawns[0].options.executable.args.slice(-5), [
		'up',
		'--detach',
		'--pull',
		'never',
		'fdp'
	]);
	const [run] = runs.getActiveComposeRuns();
	assert.deepEqual(run.services, ['fdp']);
	state.exits.get(run.id)({ exitCode: 1, output: 'failed' });
	assert.deepEqual(state.logs[0].metadata.services, ['fdp']);
});

test('run POST rejects unknown and empty service lists without spawning', async () => {
	for (const services of [['unknown'], [], ['fdp; rm -rf /']]) {
		const body = { ...input(), repoName: 'solution', action: 'up', services };
		await assert.rejects(runRoute.POST(postEvent(body)), { status: 400 });
	}
	assert.equal(state.spawns.length, 0);
});

// Sandbox versions -------------------------------------------------------------------------

test('parses image references with registry ports, tags and digests', () => {
	assert.deepEqual(image.parseImageReference('localhost:5000/polaris/fdp'), {
		repository: 'localhost:5000/polaris/fdp'
	});
	assert.deepEqual(image.parseImageReference('registry.example/fdp:26.0.47@sha256:abc'), {
		repository: 'registry.example/fdp',
		tag: '26.0.47',
		digest: 'sha256:abc'
	});
	assert.equal(
		image.withTag('registry.example:443/fdp:1@sha256:abc', '2'),
		'registry.example:443/fdp:2'
	);
	for (const tag of ['26.0.47', 'main_2026-11-20', 'v1', '_x']) assert.ok(image.isImageTag(tag));
	for (const tag of ['', '-x', '.x', 'a/b', 'a:b', 'a b', 'x'.repeat(129), 7, undefined]) {
		assert.equal(image.isImageTag(tag), false, String(tag));
	}
});

test('derives the version chip from labels first, then image references', () => {
	const version = (containers) => image.sandboxVersion('polaris', containers);
	assert.deepEqual(
		version([
			{ service: 'fdp', image: 'r/fdp:26.0.33', sandboxTag: '26.0.47' },
			{ service: 'ice', image: 'r/ice:26.0.47' },
			{ service: 'tools', image: 'polaris-tools' }
		]).label,
		'26.0.47'
	);
	assert.equal(
		version([
			{ service: 'fdp', image: 'r/fdp:1' },
			{ service: 'ice', image: 'r/ice:2' }
		]).kind,
		'mixed'
	);
	assert.deepEqual(version([{ service: 'grafana', image: 'grafana/grafana' }]), {
		kind: 'implicit',
		label: 'latest',
		services: [{ service: 'grafana', tag: 'latest', source: 'image', implicit: true }]
	});
	assert.equal(version([{ service: 'tools', image: 'polaris_tools' }]).label, 'local build');
	assert.equal(version([{ service: 'fdp', image: 'sha256:' + 'f'.repeat(64) }]).label, 'unknown');
	assert.equal(version([{ service: 'fdp', image: 'r/fdp:1', sandboxTag: 'bad tag' }]).label, '1');
});

test('refuses an invalid sandbox tag before any process starts', async () => {
	for (const tag of ['-bad', 'a/b', '../x', 'x'.repeat(129), 'a;b', 7]) {
		await assert.rejects(
			sandbox.resolveComposeTarget(root, input({ tag })),
			sandbox.ComposeTargetError
		);
		await assert.rejects(
			runRoute.POST(postEvent({ ...input({ tag }), repoName: 'solution', action: 'pull' })),
			{ status: 400 }
		);
	}
	assert.equal(state.spawns.length, 0);
	assert.equal(state.configCalls.length, 0);
	const { selection } = await sandbox.resolveComposeTarget(root, input({ tag: '26.0.47' }));
	assert.equal(selection.tag, '26.0.47');
	assert.equal(
		(await sandbox.resolveComposeTarget(root, input({ tag: '' }))).selection.tag,
		undefined
	);
});

test('a tag writes an override for registry services only, outside the repository', async () => {
	const target = await sandbox.resolveComposeTarget(root, input({ tag: '26.0.47' }));
	const inspection = await sandbox.inspectComposeTarget(target, async () => []);
	// Inspection resolves the files as they are; the override is not an input of config.
	assert.ok(!state.configCalls[0].args.includes(inspection.overrideFile));
	assert.equal(inspection.tag, '26.0.47');
	assert.ok(inspection.overrideFile.startsWith(join(temporary, 'overrides') + '/keflavik-'));
	assert.ok(!inspection.overrideFile.startsWith(repo));
	const written = await readFile(inspection.overrideFile, 'utf8');
	assert.match(written, /"fdp":\n {4}image: "registry.example\/fdp:26.0.47"/);
	assert.match(written, /devcontainer-dashboard.sandbox.tag: "26.0.47"/);
	assert.ok(!written.includes('builder'), 'a build service keeps its local image');
	const fdp = inspection.services.find((service) => service.name === 'fdp');
	assert.equal(fdp.effectiveImage, 'registry.example/fdp:26.0.47');
	// The same selection always writes the same file.
	const again = await sandbox.inspectComposeTarget(target, async () => []);
	assert.equal(again.overrideFile, inspection.overrideFile);
});

test('reports whether each registry image is on this host, with its digest', async () => {
	const target = await sandbox.resolveComposeTarget(root, input({ tag: '9' }));
	const inspection = await sandbox.inspectComposeTarget(target, async () => [], undefined, {
		imageInfo: async (reference) => (reference === 'registry.example/fdp:9' ? null : {})
	});
	const fdp = inspection.services.find((service) => service.name === 'fdp');
	assert.equal(fdp.imagePresent, false);
	assert.equal(
		inspection.services.find((service) => service.name === 'builder').imagePresent,
		undefined
	);
});

test('actions put the override last; Start never pulls; Pull skips buildable services', async () => {
	const { selection } = await sandbox.resolveComposeTarget(root, input({ tag: '2' }));
	const override = '/data/compose-overrides/keflavik-0123456789ab.yaml';
	const start = commands.composeActionCommand(repo, selection, 'up', ['fdp'], override);
	const files = start.args.flatMap((arg, index) =>
		start.args[index - 1] === '--file' ? [arg] : []
	);
	assert.equal(files.at(-1), override);
	assert.deepEqual(start.args.slice(-5), ['up', '--detach', '--pull', 'never', 'fdp']);
	assert.deepEqual(
		commands.composeActionCommand(repo, selection, 'pull', [], override).args.slice(-2),
		['pull', '--ignore-buildable']
	);
	assert.ok(commands.composeLogsCommand(repo, selection, [], override).args.includes(override));
	assert.equal(commands.composeFollowUp('up-pull'), 'up');
	assert.equal(commands.composeFollowUp('pull'), undefined);
	assert.match(commands.composeQuery(repo, selection), /&tag=2$/);
});

test('Pull and start starts Start only after a successful Pull, with the same override', async () => {
	const target = await sandbox.resolveComposeTarget(root, input({ tag: '2' }));
	const overrideFile = join(temporary, 'overrides', 'keflavik-test.yaml');
	const pull = runs.startComposeRun('pull-ok', target, 'solution', 'keflavik', 'up-pull', ['fdp'], {
		overrideFile
	});
	assert.equal(pull.tag, '2');
	assert.deepEqual(state.spawns[0].options.executable.args.slice(-3), [
		'pull',
		'--ignore-buildable',
		'fdp'
	]);
	state.exits.get('pull-ok')({ exitCode: 0, output: '' });
	await Promise.resolve();
	assert.equal(state.spawns.length, 2);
	const follow = state.spawns[1].options.executable.args;
	assert.deepEqual(follow.slice(-5), ['up', '--detach', '--pull', 'never', 'fdp']);
	assert.ok(follow.includes(overrideFile));
	const [startRun] = runs.getActiveComposeRuns().filter((run) => run.status === 'running');
	assert.equal(startRun.action, 'up');
	assert.equal(startRun.after, 'up-pull');
	assert.equal(startRun.tag, '2');

	globalThis.__composeRuns.clear();
	state.spawns = [];
	runs.startComposeRun('pull-bad', target, 'solution', 'keflavik', 'up-pull');
	state.exits.get('pull-bad')({ exitCode: 1, output: 'manifest unknown' });
	await Promise.resolve();
	assert.equal(state.spawns.length, 1, 'a failed Pull starts nothing');
});

test('run POST refuses Start for a missing registry image, and Pull records the tag', async () => {
	state.missingImages = ['registry.example/fdp:7'];
	const body = { ...input({ tag: '7' }), repoName: 'solution' };
	await assert.rejects(runRoute.POST(postEvent({ ...body, action: 'up' })), {
		status: 409,
		message: /registry.example\/fdp:7/
	});
	assert.equal(state.spawns.length, 0);
	const response = await runRoute.POST(postEvent({ ...body, action: 'pull' }));
	assert.equal((await response.json()).tag, '7');
	const args = state.spawns[0].options.executable.args;
	assert.ok(args.at(-2) === 'pull' && args.at(-1) === '--ignore-buildable');
	assert.ok(args.some((arg) => arg.startsWith(join(temporary, 'overrides'))));
	const [run] = runs.getActiveComposeRuns();
	assert.equal(run.tag, '7');
});

test('inspect GET accepts a tag and reports the override and image presence', async () => {
	state.missingImages = ['registry.example/fdp:5'];
	const url = new URL('http://localhost/api/compose');
	url.searchParams.set('repoPath', repo);
	url.searchParams.append('file', 'docker-compose.yml');
	url.searchParams.set('tag', '5');
	const body = await (await inspectRoute.GET({ url })).json();
	assert.equal(body.tag, '5');
	assert.ok(body.overrideFile);
	assert.equal(body.services.find((service) => service.name === 'fdp').imagePresent, false);
	url.searchParams.set('tag', 'bad/tag');
	await assert.rejects(inspectRoute.GET({ url }), { status: 400 });
});

// Registry tag listing ---------------------------------------------------------------------

/** A fake registry: a Bearer challenge, a token service, and two pages of tags. */
function fakeRegistry({
	tokenStatus = 200,
	pages = [
		['26.0.9', '26.0.47'],
		['26.0.10', 'latest']
	]
} = {}) {
	const calls = [];
	const fetchImpl = async (url, init = {}) => {
		const target = new URL(url);
		calls.push({ url: target.href, authorization: init.headers?.Authorization });
		if (target.host === 'auth.example') {
			return Response.json({ token: 'pull-token' }, { status: tokenStatus });
		}
		if (init.headers?.Authorization !== 'Bearer pull-token') {
			return new Response('', {
				status: 401,
				headers: {
					'www-authenticate':
						'Bearer realm="https://auth.example/jwt",service="registry.example",scope="repository:polaris/fdp:pull"'
				}
			});
		}
		const page = target.searchParams.get('last') ? 1 : 0;
		const headers =
			page === 0 ? { link: '</v2/polaris/fdp/tags/list?n=1000&last=26.0.47>; rel="next"' } : {};
		return Response.json({ name: 'polaris/fdp', tags: pages[page] }, { headers });
	};
	return { calls, fetchImpl };
}

/** Registry dependencies with fixed credentials and clock. */
function registryDeps(
	fetchImpl,
	config = { auths: { 'registry.example': { auth: btoa('axel:s3cret-token') } } }
) {
	return {
		fetch: fetchImpl,
		readDockerConfig: async () => config,
		runHelper: async () => ({ username: 'helper', secret: 'helper-secret' }),
		now: () => 1_000
	};
}

test('resolves registry locations as Docker does', () => {
	assert.deepEqual(registry.registryLocation('registry.example/polaris/fdp'), {
		host: 'registry.example',
		path: 'polaris/fdp'
	});
	assert.deepEqual(registry.registryLocation('localhost:5000/fdp'), {
		host: 'localhost:5000',
		path: 'fdp'
	});
	assert.deepEqual(registry.registryLocation('grafana/grafana'), {
		host: 'registry-1.docker.io',
		path: 'grafana/grafana'
	});
	assert.deepEqual(registry.registryLocation('redis'), {
		host: 'registry-1.docker.io',
		path: 'library/redis'
	});
	assert.deepEqual(registry.registryLocation('docker.io/redis'), {
		host: 'registry-1.docker.io',
		path: 'library/redis'
	});
});

test('lists tags through a Bearer challenge and Link pagination, newest first', async () => {
	const { calls, fetchImpl } = fakeRegistry();
	const tags = await registry.listRegistryTags(
		'registry.example/polaris/fdp',
		{},
		registryDeps(fetchImpl)
	);
	assert.deepEqual(tags, ['latest', '26.0.47', '26.0.10', '26.0.9']);
	const token = calls.find((call) => call.url.startsWith('https://auth.example/'));
	assert.match(token.url, /scope=repository%3Apolaris%2Ffdp%3Apull/);
	assert.equal(token.authorization, `Basic ${btoa('axel:s3cret-token')}`);
	assert.ok(calls.some((call) => call.url.includes('last=26.0.47')));
	// Cached for five minutes, unless refreshed.
	const cached = calls.length;
	await registry.listRegistryTags('registry.example/polaris/fdp', {}, registryDeps(fetchImpl));
	assert.equal(calls.length, cached);
	await registry.listRegistryTags(
		'registry.example/polaris/fdp',
		{ refresh: true },
		registryDeps(fetchImpl)
	);
	assert.ok(calls.length > cached);
});

test('uses a credential helper and never puts credentials in an error', async () => {
	const { calls, fetchImpl } = fakeRegistry({ tokenStatus: 401 });
	const deps = registryDeps(fetchImpl, { credHelpers: { 'registry.example': 'gitlab' } });
	await assert.rejects(
		registry.listRegistryTags('registry.example/polaris/fdp', {}, deps),
		(cause) => cause.kind === 'unauthorized' && !/helper-secret|pull-token/.test(cause.message)
	);
	assert.equal(
		calls.find((call) => call.url.startsWith('https://auth.example/')).authorization,
		`Basic ${btoa('helper:helper-secret')}`
	);
});

test('maps missing repositories, refusals without credentials and timeouts to safe kinds', async () => {
	const respond =
		(status, headers = {}) =>
		async () =>
			new Response('', { status, headers });
	await assert.rejects(
		registry.listRegistryTags('registry.example/none', {}, registryDeps(respond(404))),
		{ kind: 'not-found' }
	);
	await assert.rejects(
		registry.listRegistryTags(
			'registry.example/private',
			{},
			registryDeps(respond(401, { 'www-authenticate': 'Basic realm="x"' }), undefined)
		),
		{ kind: 'unauthorized' }
	);
	const timeout = async () => {
		throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
	};
	await assert.rejects(
		registry.listRegistryTags('registry.example/slow', {}, registryDeps(timeout)),
		{
			kind: 'timeout'
		}
	);
	assert.equal(
		registry.nextLink(
			'<https://other.example/v2/x?last=a>; rel="next"',
			new URL('https://registry.example/v2/x')
		),
		undefined
	);
});

test('tags GET lists only Compose repositories and marks tags that some images lack', async () => {
	state.configResult = {
		stdout: JSON.stringify({
			name: 'keflavik',
			services: {
				fdp: { image: 'registry.example/polaris/fdp:1' },
				ice: { image: 'registry.example/polaris/ice:1' },
				builder: { build: { context: '.' } }
			}
		})
	};
	await mkdir(process.env.DOCKER_CONFIG, { recursive: true });
	await writeFile(join(process.env.DOCKER_CONFIG, 'config.json'), '{}');
	const previousFetch = globalThis.fetch;
	const requested = [];
	globalThis.fetch = async (url) => {
		requested.push(new URL(url).pathname);
		const tags = String(url).includes('/fdp/') ? ['2', '1'] : ['1'];
		return Response.json({ tags });
	};
	try {
		const url = new URL('http://localhost/api/compose/tags');
		url.searchParams.set('repoPath', repo);
		url.searchParams.append('file', 'docker-compose.yml');
		const body = await (await tagsRoute.GET({ url })).json();
		assert.deepEqual(requested.sort(), ['/v2/polaris/fdp/tags/list', '/v2/polaris/ice/tags/list']);
		assert.deepEqual(body.tags, [
			{ name: '2', missingIn: ['ice'] },
			{ name: '1', missingIn: [] }
		]);
		assert.equal(body.images.length, 2);
		url.searchParams.append('service', 'fdp');
		const only = await (await tagsRoute.GET({ url })).json();
		assert.deepEqual(
			only.images.map((item) => item.services),
			[['fdp']]
		);
	} finally {
		globalThis.fetch = previousFetch;
	}
});

// Sandbox removal --------------------------------------------------------------------------

/** A fake Docker client for one sandbox: two containers, two networks, one volume. */
function fakeRemovalDocker() {
	const calls = [];
	const project = (labels = {}) => ({
		'com.docker.compose.project': 'keflavik',
		'com.docker.compose.project.working_dir': '/workspaces/task/solution',
		...labels
	});
	const world = {
		containers: [
			{
				Id: 'c1'.padEnd(64, '0'),
				Names: ['/keflavik-fdp-1'],
				State: 'running',
				Image: 'registry.example/fdp:26.0.47',
				Labels: project({
					'com.docker.compose.service': 'fdp',
					'devcontainer-dashboard.sandbox.tag': '26.0.47'
				})
			},
			{
				Id: 'c2'.padEnd(64, '0'),
				Names: ['/keflavik-ice-1'],
				State: 'exited',
				Image: 'registry.example/ice:26.0.47',
				Labels: project({
					'com.docker.compose.service': 'ice',
					'devcontainer-dashboard.sandbox.tag': '26.0.47'
				})
			}
		],
		networks: [
			{
				Id: 'n-default',
				Name: 'keflavik_default',
				Containers: { ['c1'.padEnd(64, '0')]: { Name: 'keflavik-fdp-1' } }
			},
			{
				Id: 'n-oplan',
				Name: 'keflavik_oplan',
				Containers: {
					['d'.repeat(64)]: { Name: 'polaris-dev' },
					['c1'.padEnd(64, '0')]: { Name: 'keflavik-fdp-1' }
				}
			}
		],
		volumes: [{ Name: 'keflavik_fdp-data' }]
	};
	const client = {
		async listContainers(options) {
			calls.push(['listContainers', options]);
			return world.containers;
		},
		async listNetworks() {
			return world.networks.map(({ Id, Name }) => ({ Id, Name }));
		},
		async inspectNetwork(id) {
			return { Containers: world.networks.find((network) => network.Id === id).Containers };
		},
		async listVolumes() {
			return world.volumes;
		},
		async stopContainer(id, seconds) {
			calls.push(['stop', id, seconds]);
		},
		async removeContainer(id) {
			calls.push(['removeContainer', id]);
		},
		async removeNetwork(id) {
			calls.push(['removeNetwork', id]);
		}
	};
	return { calls, world, client };
}

test('removal preview lists what goes and keeps networks with outside containers', async () => {
	const { calls, client } = fakeRemovalDocker();
	const preview = await removal.previewSandboxRemoval(client, 'keflavik');
	assert.deepEqual(calls[0][1], {
		all: true,
		filters: { label: ['com.docker.compose.project=keflavik'] }
	});
	assert.equal(preview.version, '26.0.47');
	assert.equal(preview.source, '/workspaces/task/solution');
	assert.deepEqual(
		preview.containers.map((item) => item.name),
		['keflavik-fdp-1', 'keflavik-ice-1']
	);
	assert.deepEqual(
		preview.networks.map((item) => [item.name, item.attached]),
		[
			['keflavik_default', []],
			['keflavik_oplan', ['polaris-dev']]
		]
	);
	assert.deepEqual(preview.volumes, ['keflavik_fdp-data']);
	assert.match(preview.token, /^[a-f0-9]{32}$/);
	for (const project of ['', 'Keflavik', 'x;rm', '../x', '-x']) {
		await assert.rejects(removal.previewSandboxRemoval(client, project), removal.RemovalInputError);
	}
});

test('removal keeps volumes and shared networks, and reports every resource', async () => {
	const { calls, client } = fakeRemovalDocker();
	const { token } = await removal.previewSandboxRemoval(client, 'keflavik');
	const results = await removal.removeSandbox(client, 'keflavik', token);
	assert.deepEqual(
		results.map((item) => [item.kind, item.name, item.result]),
		[
			['container', 'keflavik-fdp-1', 'removed'],
			['container', 'keflavik-ice-1', 'removed'],
			['network', 'keflavik_default', 'removed'],
			['network', 'keflavik_oplan', 'kept'],
			['volume', 'keflavik_fdp-data', 'kept']
		]
	);
	assert.deepEqual(
		calls.filter((call) => call[0] === 'stop').map((call) => call[2]),
		[10],
		'only the running container is stopped, with a grace period'
	);
	assert.deepEqual(
		calls.filter((call) => call[0] === 'removeNetwork').map((call) => call[1]),
		['n-default']
	);
	assert.ok(!calls.some((call) => /volume/i.test(call[0])));
});

test('removal refuses a stale preview without touching anything', async () => {
	const { calls, world, client } = fakeRemovalDocker();
	const { token } = await removal.previewSandboxRemoval(client, 'keflavik');
	world.containers.push({
		Id: 'c3'.padEnd(64, '0'),
		Names: ['/keflavik-debug-1'],
		State: 'running',
		Labels: {}
	});
	await assert.rejects(removal.removeSandbox(client, 'keflavik', token), removal.RemovalStaleError);
	assert.ok(!calls.some((call) => ['stop', 'removeContainer', 'removeNetwork'].includes(call[0])));
	await assert.rejects(
		removal.removeSandbox(client, 'keflavik', 'not-a-token'),
		removal.RemovalInputError
	);
});

test('removal and Compose runs of one project exclude each other', async () => {
	const target = await sandbox.resolveComposeTarget(root, input());
	runs.startComposeRun('busy', target, 'solution', 'keflavik', 'up');
	const { client } = fakeRemovalDocker();
	const { token } = await removal.previewSandboxRemoval(client, 'keflavik');
	await assert.rejects(removal.removeSandbox(client, 'keflavik', token), runs.ComposeRunConflict);
	globalThis.__composeRuns.clear();
	const release = runs.reserveProjectRemoval('keflavik');
	assert.throws(
		() => runs.startComposeRun('blocked', target, 'solution', 'keflavik', 'up'),
		runs.ComposeRunConflict
	);
	release();
	assert.equal(
		runs.startComposeRun('free', target, 'solution', 'keflavik', 'up').status,
		'running'
	);
});

test('remove routes map stale previews to 409 and bad input to 400', async () => {
	await assert.rejects(
		removeRoute.GET({ url: new URL('http://localhost/api/compose/remove?project=Bad') }),
		{
			status: 400
		}
	);
	const post = (body) =>
		removeRoute.POST({
			request: new Request('http://localhost/api/compose/remove', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			})
		});
	await assert.rejects(post({ project: 'keflavik' }), { status: 400 });
	await assert.rejects(post({ project: 'keflavik; rm', token: 'a'.repeat(32) }), { status: 400 });
});

/** Representative literal descriptor with fields that must stay on the server. */
function profileDescriptor() {
	return {
		schema: 1,
		kind: 'fixture-stack',
		presenter: 'profile',
		services: { web: { role: 'app' } },
		defaults: { services: ['web'] },
		panels: ['choice:mode'],
		instances: {
			files: [
				{
					id: 'hosts',
					from: { path: 'fixtures/private-hosts' },
					rewrite: 'addresses',
					mount: { role: 'app', target: '/etc/fixture-hosts' }
				}
			]
		},
		actions: {
			mode: {
				type: 'choice',
				label: 'Mode',
				options: ['one', 'two'],
				confirm: ['two'],
				services: ['web'],
				argv: ['fixture-command', '{option}'],
				readBack: ['fixture-readback']
			}
		}
	};
}

test('kind descriptors reject unknown fields, invalid paths, interpolation and oversized values', () => {
	const validate = kindDescriptor.parseKindDescriptor;
	const parsed = validate(profileDescriptor());
	assert.equal(parsed.view.kind, 'fixture-stack');
	assert.deepEqual(parsed.view.actions, [
		{ id: 'mode', label: 'Mode', options: ['one', 'two'], confirm: ['two'] }
	]);
	const candidates = [
		{ ...profileDescriptor(), unknown: 'not-returned' },
		{ ...profileDescriptor(), title: '${PASSWORD}' },
		{ ...profileDescriptor(), title: 'a'.repeat(40000) },
		{
			...profileDescriptor(),
			instances: {
				files: [{ ...profileDescriptor().instances.files[0], from: { path: '../secret' } }]
			}
		},
		{
			...profileDescriptor(),
			instances: {
				files: [
					{
						...profileDescriptor().instances.files[0],
						mount: { target: 'relative/file', role: 'app' }
					}
				]
			}
		}
	];
	for (const candidate of candidates)
		assert.throws(() => validate(candidate), kindDescriptor.KindDescriptorError);
});

test('kind discovery respects precedence and keeps display-only fallbacks separate from policy', async () => {
	const input = {
		extension: profileDescriptor(),
		literalExtension: async () => profileDescriptor(),
		operatorProfile: async () => ({ schema: 1, kind: 'operator-stack' }),
		labels: ['database'],
		services: []
	};
	const resolve = composeKinds.resolveComposeKind;
	assert.equal((await resolve(input)).view.source, 'compose');
	assert.equal((await resolve({ ...input, extension: undefined })).view.source, 'operator');
	const labelsOnly = { ...input, extension: undefined, operatorProfile: async () => undefined };
	assert.deepEqual(await resolve(labelsOnly), {
		view: { kind: 'database', presenter: 'database', source: 'label' }
	});
	assert.equal(
		(await resolve({ ...labelsOnly, labels: ['database', 'web'] })).view.kind,
		'generic'
	);
	assert.equal((await resolve({ ...labelsOnly, labels: ['unknown-value'] })).view.kind, 'generic');
	assert.equal(
		(
			await resolve({
				...labelsOnly,
				labels: [],
				services: [{ image: 'docker.io/library/postgres:17', ports: [] }]
			})
		).view.kind,
		'database'
	);
	assert.equal(
		(
			await resolve({
				...labelsOnly,
				labels: [],
				services: [{ image: 'example.test/library/postgres:17', ports: [] }]
			})
		).view.kind,
		'generic'
	);
	assert.equal(
		(
			await resolve({
				...labelsOnly,
				labels: [],
				services: [{ ports: [{ target: '80', protocol: 'tcp', published: '8080' }] }]
			})
		).view.kind,
		'web'
	);
});

test('inspection hides execution metadata and rejects interpolated declarations without breaking the original stack', async () => {
	const target = await sandbox.resolveComposeTarget(root, input());
	const descriptor = profileDescriptor();
	const raw = (extension) => ({
		stdout: JSON.stringify({ ...JSON.parse(resolvedConfig()), 'x-devharbour': extension }),
		stderr: ''
	});
	const inspect = (literal) =>
		sandbox.inspectComposeTarget(
			target,
			async () => [],
			async (_, mode) => (mode ? raw(literal) : raw(descriptor))
		);
	const accepted = await inspect(descriptor);
	assert.equal(accepted.kind.source, 'compose');
	assert.doesNotMatch(
		JSON.stringify(accepted),
		/fixture-command|fixture-readback|private-hosts|never-return-this/
	);
	const rejected = await inspect({ ...descriptor, kind: '${TOKEN}' });
	assert.equal(rejected.kind.kind, 'generic');
	assert.equal(rejected.warnings.length, 1);
	assert.equal(rejected.projectName, 'keflavik');
	assert.doesNotMatch(JSON.stringify(rejected), /TOKEN|never-return-this/);
});

/** A daemon-free fixture in the shape emitted by Compose config. */
function instanceFixture() {
	return {
		name: 'example',
		networks: {
			demo: {
				ipam: {
					config: [
						{
							subnet: '192.168.20.0/24',
							gateway: '192.168.20.1',
							ip_range: '192.168.20.128/25',
							aux_addresses: { db: '192.168.20.20' }
						}
					]
				}
			},
			shared: { external: true }
		},
		services: {
			web: {
				container_name: 'example-web',
				networks: { demo: { ipv4_address: '192.168.20.10' }, shared: null },
				extra_hosts: ['db=192.168.20.20', 'mirror:192.168.20.21', 'local=::1'],
				ports: [{ target: 80, published: '8888' }, { target: 443 }],
				environment: { APP_URL: 'http://192.168.20.20/secret-marker' }
			}
		},
		volumes: { data: { name: 'shared-data' }, shared: { external: true } }
	};
}

test('instance planner remaps fixture offsets and scopes names without copying environment values', () => {
	const config = instanceFixture();
	const before = JSON.stringify(config);
	const plan = instancePlan.planComposeInstance(config, 21);
	assert.equal(plan.project, 'example-i21');
	assert.equal(plan.addressPlan.subnets[0].to, '10.231.21.0/24');
	assert.deepEqual(plan.override.networks.demo.ipam.value.config, [
		{
			subnet: '10.231.21.0/24',
			gateway: '10.231.21.1',
			ip_range: '10.231.21.128/25',
			aux_addresses: { db: '10.231.21.20' }
		}
	]);
	assert.equal(plan.override.networks.shared, undefined);
	assert.deepEqual(plan.override.services.web.networks.demo, {
		ipv4_address: '10.231.21.10',
		aliases: ['example-web']
	});
	assert.equal(plan.override.services.web.networks.shared, undefined);
	assert.deepEqual(plan.override.services.web.extra_hosts.value, [
		'db=10.231.21.20',
		'mirror=10.231.21.21',
		'local=::1'
	]);
	assert.deepEqual(plan.override.services.web.ports.value, [
		{ target: 80, protocol: 'tcp', host_ip: '127.0.0.1' },
		{ target: 443, protocol: 'tcp', host_ip: '127.0.0.1' }
	]);
	assert.equal(plan.override.volumes.data.name, 'example-i21_data');
	assert.equal(plan.override.volumes.shared, undefined);
	assert.match(plan.warnings[0], /APP_URL/);
	assert.doesNotMatch(JSON.stringify(plan), /secret-marker/);
	assert.equal(JSON.stringify(config), before);
});

test('instance planner refuses collisions, shared static addresses, unsupported namespaces and IPv6', () => {
	const plan = instancePlan.planComposeInstance;
	assert.throws(
		() => plan(instanceFixture(), 21, { occupiedSubnets: ['10.231.0.0/16'] }),
		/overlaps/
	);
	assert.throws(
		() => plan(instanceFixture(), 21, { occupiedProjects: ['example-i21'] }),
		/already in use/
	);
	assert.throws(
		() => plan(instanceFixture(), 20, { defaultSubnet: '192.168.{slot}.0/24' }),
		/overlaps/
	);
	assert.throws(() => plan(instanceFixture(), 256), /outside the instance pool/);
	const config = instanceFixture();
	config.services.web.networks.shared = { ipv4_address: '10.1.1.10' };
	assert.throws(() => plan(config, 21), /remappable subnet/);
	config.services.web.networks.shared = null;
	config.services.web.network_mode = 'host';
	assert.throws(() => plan(config, 21), /namespace/);
	delete config.services.web.network_mode;
	config.networks.demo.enable_ipv6 = true;
	assert.throws(() => plan(config, 21), /IPv4-only/);
});
