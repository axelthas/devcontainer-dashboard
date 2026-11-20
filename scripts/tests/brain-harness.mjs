/**
 * Load the dependency-free Brain modules from their TypeScript sources. Each module is
 * stripped of types into a temporary tree that keeps the relative `.js` imports valid, and
 * a stub replaces the Dockerode singleton. Tests inject a fake Docker client instead.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const BRAIN_MODULES = [
	'state',
	'exposure',
	'executions',
	'shells',
	'viewers',
	'access',
	'tools',
	'mcp',
	'gateway',
	'startup'
];

/** Copy one stripped module into the temporary tree. */
async function copyStripped(source, target) {
	const code = stripTypeScriptTypes(await readFile(join(repository, source), 'utf8'));
	await writeFile(target, code);
}

/** Build the temporary tree once per test file and import every module. */
export async function loadBrain() {
	const root = await mkdtemp(join(tmpdir(), 'ddash-brain-'));
	await mkdir(join(root, 'server/brain'), { recursive: true });
	await writeFile(join(root, 'server/docker.js'), 'export default {};\n');
	await copyStripped('src/lib/brainTypes.ts', join(root, 'brainTypes.js'));
	await copyStripped('src/lib/server/tailscaleServe.ts', join(root, 'server/tailscaleServe.js'));
	const modules = {};
	for (const name of BRAIN_MODULES)
		await copyStripped(`src/lib/server/brain/${name}.ts`, join(root, `server/brain/${name}.js`));
	for (const name of BRAIN_MODULES)
		modules[name] = await import(pathToFileURL(join(root, `server/brain/${name}.js`)).href);
	modules.serve = await import(pathToFileURL(join(root, 'server/tailscaleServe.js')).href);
	modules.cleanup = () => rm(root, { recursive: true, force: true });
	return modules;
}

/** A hijacked TTY exec connection: tests push raw PTY output, and input writes are recorded. */
export function execStream() {
	const stream = new Duplex({
		read() {},
		write(chunk, _encoding, callback) {
			stream.written.push(chunk.toString());
			callback();
		},
		final(callback) {
			stream.stdinEnded = true;
			callback();
		}
	});
	stream.written = [];
	stream.stdinEnded = false;
	return stream;
}

/**
 * Fake Dockerode client. `containers` maps full IDs to inspect results. `onExec` receives
 * the exec options and returns `{ stream, inspect }` for that exec. `resizes` records PTY sizes.
 */
export function fakeDocker(containers, onExec) {
	const execs = [];
	const resizes = [];
	return {
		execs,
		resizes,
		getContainer(id) {
			return {
				async inspect() {
					const info = containers.get(id);
					if (!info) throw Object.assign(new Error('No such container'), { statusCode: 404 });
					return info;
				},
				async exec(options) {
					const behaviour = onExec(options, id);
					execs.push({ id, options });
					return {
						async start() {
							if (behaviour.startError) throw behaviour.startError;
							return behaviour.stream;
						},
						async inspect() {
							return behaviour.inspect();
						},
						async resize(size) {
							resizes.push(size);
						}
					};
				}
			};
		}
	};
}

/** A running container inspect result with one start time. */
export function runningContainer(id, startedAt = '2026-11-18T20:00:00.000000000Z', extra = {}) {
	return {
		Id: id,
		Name: '/sample',
		State: { Running: true, StartedAt: startedAt },
		Config: { User: '', Env: [], Labels: {} },
		HostConfig: {},
		Mounts: [],
		...extra
	};
}

/** Grant target fields for tests. */
export function target(containerId, overrides = {}) {
	return {
		containerId,
		containerName: 'sample',
		kind: 'devcontainer',
		startedAt: '2026-11-18T20:00:00.000000000Z',
		execUser: 'developer',
		user: 'developer',
		userSource: 'remoteUser in the devcontainer metadata',
		workdir: '/workspaces/sample',
		exposure: [],
		...overrides
	};
}
