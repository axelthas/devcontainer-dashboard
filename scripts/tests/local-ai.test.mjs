/** Focused path and authenticated streaming tests. No Docker or npm dependencies. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { aiFolder, aiFolders } from '../../src/lib/server/localAiPaths.ts';
import { startAiGateway } from '../../src/lib/server/localAiGateway.ts';
import {
	sessionArguments,
	sessionId,
	tuiArguments,
	launchRegistry
} from '../../src/lib/server/localAiSession.ts';

test('v2 session creation sends a literal location in the body and reads the data envelope', () => {
	const directory = "/workspaces/not git/' $(touch nope); Ísland";
	const args = sessionArguments(directory, 'http://127.0.0.1:45678');
	assert.deepEqual(args.slice(0, 3), ['api', 'session.create', '--data']);
	assert.deepEqual(JSON.parse(args[3]).location, { directory });
	assert.deepEqual(args.slice(4), ['--server', 'http://127.0.0.1:45678']);
	assert.deepEqual(tuiArguments('http://127.0.0.1:45678', 'ses_example'), [
		'--server',
		'http://127.0.0.1:45678',
		'--session',
		'ses_example'
	]);
	assert.throws(() => sessionArguments(directory, ''));
	assert.throws(() => tuiArguments('https://attacker.test', 'ses_example'));
	assert.throws(() => tuiArguments('http://127.0.0.1:70000', 'ses_example'));
	assert.throws(() => tuiArguments('http://127.0.0.1:45678', 'ses_x; touch nope'));
	assert.equal(sessionId('{"data":{"id":"ses_example"}}'), 'ses_example');
	assert.throws(() => sessionId('{"id":"old-v1-shape"}'));
	assert.throws(() => sessionId('{"data":{"id":"//attacker"}}'));
});

test('concurrent viewer launches and reloads share one operation, never a second TUI', async () => {
	const once = launchRegistry(2);
	let count = 0;
	const create = async () => {
		count++;
		return { terminalId: 'ai-first' };
	};
	const first = once('first', '/workspace:opencode', create);
	const duplicate = once('first', '/workspace:opencode', create);
	assert.equal(first, duplicate);
	assert.deepEqual(await first, { terminalId: 'ai-first' });
	assert.deepEqual(await once('first', '/workspace:opencode', create), { terminalId: 'ai-first' });
	assert.equal(count, 1);
	await assert.rejects(once('first', '/other:opencode', create), /already used/);
	await assert.rejects(once('first', '/workspace:openchamber', create), /already used/);
	await once('second', '/workspace:openchamber', create);
	await assert.rejects(once('third', '/workspace:opencode', create), /capacity/);
	await assert.rejects(once('../bad', 'key', create), /identity/);
	assert.equal(count, 2);
});

test('a failed or uncertain launch is retained rather than retried as new work', async () => {
	const once = launchRegistry();
	let count = 0;
	const create = async () => {
		count++;
		throw new Error('backend unavailable');
	};
	await assert.rejects(once('failed', 'key', create), /backend unavailable/);
	await assert.rejects(once('failed', 'key', create), /backend unavailable/);
	assert.equal(count, 1);
});

test('workspace rows and folder rows launch attach-only service windows', async () => {
	const { readFile } = await import('node:fs/promises');
	const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
	const buttons = await read('src/lib/components/LocalAiButtons.svelte');
	assert.match(buttons, /window\.open/);
	assert.match(buttons, /crypto\.randomUUID\(\)/);
	assert.match(buttons, /noopener,noreferrer/);
	const rows = await read('src/lib/components/LocalWorkspaces.svelte');
	assert.match(rows, /<LocalAiButtons path=\{ws\.path\}/);
	assert.match(rows, /<LocalAiButtons path=\{repo\.path\}/);
	const viewer = await read('src/routes/ai/+page.svelte');
	assert.match(viewer, /<LocalAiButtons path=\{folder\.path\}/);
	assert.match(viewer, /<TerminalTab\s+sessionId=\{terminalId\}/);
	assert.doesNotMatch(viewer, /command="opencode"/);
	assert.match(viewer, /url\.searchParams\.set\('instance', data\.viewer\.instance\)/);
});

test('runtime starts one backend and explicitly shares it across API, TUI and OpenChamber', async () => {
	// Replace process boundaries only. Execute the actual runtime and real path validation.
	const { readFile } = await import('node:fs/promises');
	const { pathToFileURL } = await import('node:url');
	const temp = await mkdtemp(join(tmpdir(), 'ddash-ai-runtime-'));
	const originalFetch = globalThis.fetch;
	const originalEnabled = process.env.LOCAL_AI_ENABLED;
	const originalRoot = process.env.WORKSPACE_ROOT;
	let handle;
	try {
		const mockFile = join(temp, 'boundary.mjs');
		await writeFile(
			mockFile,
			`
			import { EventEmitter } from 'node:events';
			export const calls = { spawns: [], commands: [], terminals: [], stops: [] };
			export function spawn(command, args, options) {
				const child = new EventEmitter();
				Object.assign(child, { pid: 90000 + calls.spawns.length, exitCode: null, signalCode: null });
				calls.spawns.push({ command, args, options, child });
				return child;
			}
			export function execFile() {}
			execFile[Symbol.for('nodejs.util.promisify.custom')] = async (command, args, options) => {
				calls.commands.push({ command, args, options });
				return { stdout: JSON.stringify({ data: { id: 'ses_' + calls.commands.length } }), stderr: '' };
			};
			export function createPersistentSession(id, command, cwd, options) {
				calls.terminals.push({ id, command, cwd, options });
			}
			export async function terminateTerminalTree(pid) { calls.stops.push(pid); }
		`
		);
		const boundary = pathToFileURL(mockFile).href;
		let source = await readFile(
			new URL('../../src/lib/server/localAi.ts', import.meta.url),
			'utf8'
		);
		source = source.replace("'node:child_process'", JSON.stringify(boundary));
		for (const name of ['localAiPaths', 'localAiSession', 'localAiGateway']) {
			source = source.replaceAll(
				`'./${name}.js'`,
				JSON.stringify(new URL(`../../src/lib/server/${name}.ts`, import.meta.url).href)
			);
		}
		source = source.replace("'./terminalProcesses.js'", JSON.stringify(boundary));
		source = source.replace("'./terminal.js'", JSON.stringify(boundary));
		await writeFile(join(temp, 'runtime.ts'), source);
		const runtime = await import(pathToFileURL(join(temp, 'runtime.ts')).href);
		const { calls } = await import(boundary);
		globalThis.fetch = async () => new Response('{}');
		process.env.LOCAL_AI_ENABLED = '1';
		process.env.WORKSPACE_ROOT = temp;
		const options = {
			tailscale: true,
			authenticated: () => true,
			ensureOrigin: async () => 'https://dashboard.example:10001'
		};
		handle = await runtime.startLocalAi(options);
		assert.equal(await runtime.startLocalAi(options), null);
		const deadline = Date.now() + 5000;
		while (runtime.localAiStatus().state === 'starting' && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(runtime.localAiStatus().state, 'ready');
		assert.equal(calls.spawns.length, 2);
		assert.equal(calls.spawns[0].command, 'opencode');
		assert.equal(calls.spawns[1].command, 'openchamber');
		const endpoint = calls.spawns[1].options.env.OPENCODE_HOST;
		assert.equal(calls.spawns[1].options.env.OPENCODE_SKIP_START, 'true');
		assert.equal(endpoint, `http://127.0.0.1:${calls.spawns[0].args.at(-1)}`);
		assert.equal(calls.spawns[1].options.env.OPENCODE_PORT, calls.spawns[0].args.at(-1));
		const request = {
			path: temp,
			tool: 'opencode',
			launch: 'viewer1',
			instance: runtime.localAiStatus().instance
		};
		const dashboard = new URL('https://dashboard.example');
		const [first, second] = await Promise.all([
			runtime.openLocalAi(request, dashboard),
			runtime.openLocalAi(request, dashboard)
		]);
		assert.deepEqual(first, second);
		assert.deepEqual(first, { terminalId: 'ai-viewer1' });
		assert.equal(calls.commands.length, 1);
		assert.equal(calls.terminals.length, 1);
		assert.deepEqual(calls.terminals[0].options.executable, {
			file: 'opencode',
			args: ['--server', endpoint, '--session', 'ses_1']
		});
		assert.equal(calls.terminals[0].cwd, temp);
		assert.equal(calls.terminals[0].command, undefined);
		const chamber = await runtime.openLocalAi(
			{ ...request, tool: 'openchamber', launch: 'viewer2' },
			dashboard
		);
		assert.equal(chamber.target, 'https://dashboard.example:10001/?session=ses_2');
		for (const call of calls.commands) {
			assert.deepEqual(call.args.slice(-2), ['--server', endpoint]);
			assert.equal(JSON.parse(call.args[3]).location.directory, temp);
		}
		await assert.rejects(
			runtime.openLocalAi({ ...request, instance: 'old' }, dashboard),
			/restarted/
		);
		calls.spawns[0].child.emit('exit', 1);
		await assert.rejects(
			runtime.openLocalAi({ ...request, launch: 'viewer3' }, dashboard),
			/not ready/
		);
		assert.equal(await runtime.startLocalAi(options), null);
		assert.equal(calls.spawns.length, 2);
		assert.equal(calls.commands.length, 2);
	} finally {
		await handle?.close();
		globalThis.fetch = originalFetch;
		if (originalEnabled === undefined) delete process.env.LOCAL_AI_ENABLED;
		else process.env.LOCAL_AI_ENABLED = originalEnabled;
		if (originalRoot === undefined) delete process.env.WORKSPACE_ROOT;
		else process.env.WORKSPACE_ROOT = originalRoot;
		await rm(temp, { recursive: true, force: true });
	}
});

/** Allocate a test listener, returning its actual ephemeral port. */
async function listen(server) {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return server.address().port;
}

/** Make one HTTP request while preserving the desired browser-facing Host and Origin. */
async function request(port, headers = {}, method = 'GET') {
	return new Promise((resolve, reject) => {
		const peer = http.request(
			{
				host: '127.0.0.1',
				port,
				path: '/api/example?q=1',
				method,
				headers: { host: 'localhost:3002', ...headers }
			},
			(response) => {
				let body = '';
				response.on('data', (data) => {
					body += data;
				});
				response.on('end', () =>
					resolve({ status: response.statusCode, headers: response.headers, body })
				);
			}
		);
		peer.on('error', reject);
		peer.end();
	});
}

test('folder picker includes ordinary directories, spaces and safe links but rejects escapes', async () => {
	const temp = await mkdtemp(join(tmpdir(), 'ddash-ai-'));
	try {
		const root = join(temp, 'workspace');
		await mkdir(join(root, 'plain folder'), { recursive: true });
		await mkdir(join(temp, 'workspace-other'));
		await writeFile(join(root, 'not-a-folder'), 'fixture');
		await symlink(join(root, 'plain folder'), join(root, 'safe'));
		await symlink(join(temp, 'workspace-other'), join(root, 'escape'));
		await symlink(join(root, 'missing'), join(root, 'broken'));
		assert.equal(await aiFolder(root, root), root);
		assert.equal(await aiFolder(root, join(root, 'safe')), join(root, 'plain folder'));
		await assert.rejects(aiFolder(root, join(root, 'escape')));
		await assert.rejects(aiFolder(root, join(temp, 'workspace-other')));
		await assert.rejects(aiFolder(root, join(root, 'not-a-folder')));
		await assert.rejects(aiFolder(root, '../workspace'));
		const listing = await aiFolders(root);
		assert.deepEqual(
			listing.children.map((item) => item.name),
			['plain folder', 'safe']
		);
		assert.equal(listing.parent, null);
		assert.equal((await aiFolders(root, join(root, 'plain folder'))).parent, root);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

test('dedicated origin requires auth and matching write Origin, and isolates credentials', async () => {
	let received;
	const upstream = http.createServer((req, res) => {
		received = { headers: req.headers, path: req.url };
		res.setHeader('set-cookie', [
			'app-session=example; Path=/; HttpOnly',
			'devcontainer-dashboard-session=attack; Path=/'
		]);
		res.setHeader('access-control-allow-origin', '*');
		res.end('upstream');
	});
	const upstreamPort = await listen(upstream);
	const reservation = net.createServer();
	const port = await listen(reservation);
	await new Promise((resolve) => reservation.close(resolve));
	let alive = true;
	const gateway = await startAiGateway({
		port,
		origins: ['http://localhost:3002'],
		upstream: () => (alive ? upstreamPort : undefined),
		authenticated: (cookie) => cookie?.includes('devcontainer-dashboard-session=valid') ?? false
	});
	try {
		assert.equal((await request(port)).status, 403);
		const cookie =
			'devcontainer-dashboard-session=valid; other=secret; ddash-local-ai-app-session=abc';
		assert.equal((await request(port, { cookie }, 'POST')).status, 403);
		assert.equal(
			(await request(port, { cookie, origin: 'http://attacker.test' }, 'POST')).status,
			403
		);
		assert.equal((await request(port, { cookie, host: 'attacker.test' })).status, 403);
		const response = await request(
			port,
			{
				cookie,
				origin: 'http://localhost:3002',
				authorization: 'Basic c2VjcmV0',
				'x-forwarded-host': 'attacker.test'
			},
			'POST'
		);
		assert.equal(response.status, 200);
		assert.equal(received.path, '/api/example?q=1');
		assert.equal(received.headers.cookie, 'app-session=abc');
		assert.equal(received.headers.authorization, undefined);
		assert.equal(received.headers['x-forwarded-host'], 'localhost:3002');
		assert.equal(response.headers['access-control-allow-origin'], undefined);
		assert.deepEqual(response.headers['set-cookie'], [
			'ddash-local-ai-app-session=example; Path=/; HttpOnly'
		]);
		alive = false;
		assert.equal((await request(port, { cookie })).status, 403);
	} finally {
		await gateway.close();
		await new Promise((resolve) => upstream.close(resolve));
	}
});

test('gateway blocks service-worker registration and cross-origin redirects', async () => {
	const upstream = http.createServer((_req, res) => {
		res.writeHead(302, { location: 'https://attacker.test/' });
		res.end();
	});
	const upstreamPort = await listen(upstream);
	const reservation = net.createServer();
	const port = await listen(reservation);
	await new Promise((resolve) => reservation.close(resolve));
	const gateway = await startAiGateway({
		port,
		origins: ['http://localhost:3002'],
		upstream: () => upstreamPort,
		authenticated: () => true
	});
	try {
		assert.equal((await request(port, { 'service-worker': 'script' })).status, 403);
		assert.equal((await request(port)).status, 502);
	} finally {
		await gateway.close();
		await new Promise((resolve) => upstream.close(resolve));
	}
});

test('WebSocket upgrades require the application Origin', async () => {
	const reservation = net.createServer();
	const port = await listen(reservation);
	await new Promise((resolve) => reservation.close(resolve));
	const gateway = await startAiGateway({
		port,
		origins: ['http://localhost:3002'],
		upstream: () => 1,
		authenticated: () => true
	});
	try {
		const response = await new Promise((resolve, reject) => {
			const socket = net.connect(port, '127.0.0.1', () => {
				socket.write(
					'GET /socket HTTP/1.1\r\nHost: localhost:3002\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: http://attacker.test\r\n\r\n'
				);
			});
			let text = '';
			socket.on('data', (data) => {
				text += data;
			});
			socket.on('end', () => resolve(text));
			socket.on('error', reject);
		});
		assert.match(response, /^HTTP\/1.1 403/);
	} finally {
		await gateway.close();
	}
});
