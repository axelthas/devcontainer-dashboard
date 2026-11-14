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
import { sessionArguments, sessionId } from '../../src/lib/server/localAiSession.ts';

test('v2 session creation sends a literal location in the body and reads the data envelope', () => {
	const directory = "/workspaces/not git/' $(touch nope); Ísland";
	const args = sessionArguments(directory);
	assert.deepEqual(args.slice(0, 3), ['api', 'session.create', '--data']);
	assert.deepEqual(JSON.parse(args[3]).location, { directory });
	assert.equal(sessionId('{"data":{"id":"ses_example"}}'), 'ses_example');
	assert.throws(() => sessionId('{"id":"old-v1-shape"}'));
	assert.throws(() => sessionId('{"data":{"id":"//attacker"}}'));
});

/** Allocate a test listener, returning its actual ephemeral port. */
async function listen(server) {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return server.address().port;
}

/** Make one HTTP request while preserving the desired browser-facing Host and Origin. */
async function request(port, headers = {}, method = 'GET') {
	return new Promise((resolve, reject) => {
		const peer = http.request({ host: '127.0.0.1', port, path: '/api/example?q=1',
			method, headers: { host: 'localhost:3002', ...headers } }, (response) => {
			let body = '';
			response.on('data', (data) => { body += data; });
			response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
		});
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
		assert.deepEqual(listing.children.map((item) => item.name), ['plain folder', 'safe']);
		assert.equal(listing.parent, null);
		assert.equal((await aiFolders(root, join(root, 'plain folder'))).parent, root);
	} finally { await rm(temp, { recursive: true, force: true }); }
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
	const gateway = await startAiGateway({ port, origins: ['http://localhost:3002'],
		upstream: () => alive ? upstreamPort : undefined,
		authenticated: (cookie) => cookie?.includes('devcontainer-dashboard-session=valid') ?? false });
	try {
		assert.equal((await request(port)).status, 403);
		const cookie = 'devcontainer-dashboard-session=valid; other=secret; ddash-local-ai-app-session=abc';
		assert.equal((await request(port, { cookie }, 'POST')).status, 403);
		assert.equal((await request(port, { cookie, origin: 'http://attacker.test' }, 'POST')).status, 403);
		assert.equal((await request(port, { cookie, host: 'attacker.test' })).status, 403);
		const response = await request(port, { cookie, origin: 'http://localhost:3002',
			authorization: 'Basic c2VjcmV0', 'x-forwarded-host': 'attacker.test' }, 'POST');
		assert.equal(response.status, 200);
		assert.equal(received.path, '/api/example?q=1');
		assert.equal(received.headers.cookie, 'app-session=abc');
		assert.equal(received.headers.authorization, undefined);
		assert.equal(received.headers['x-forwarded-host'], 'localhost:3002');
		assert.equal(response.headers['access-control-allow-origin'], undefined);
		assert.deepEqual(response.headers['set-cookie'], ['ddash-local-ai-app-session=example; Path=/; HttpOnly']);
		alive = false;
		assert.equal((await request(port, { cookie })).status, 403);
	} finally {
		await gateway.close();
		await new Promise((resolve) => upstream.close(resolve));
	}
});

test('gateway blocks service-worker registration and cross-origin redirects', async () => {
	const upstream = http.createServer((_req, res) => {
		res.writeHead(302, { location: 'https://attacker.test/' }); res.end();
	});
	const upstreamPort = await listen(upstream);
	const reservation = net.createServer();
	const port = await listen(reservation);
	await new Promise((resolve) => reservation.close(resolve));
	const gateway = await startAiGateway({ port, origins: ['http://localhost:3002'],
		upstream: () => upstreamPort, authenticated: () => true });
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
	const gateway = await startAiGateway({ port, origins: ['http://localhost:3002'],
		upstream: () => 1, authenticated: () => true });
	try {
		const response = await new Promise((resolve, reject) => {
			const socket = net.connect(port, '127.0.0.1', () => {
				socket.write('GET /socket HTTP/1.1\r\nHost: localhost:3002\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: http://attacker.test\r\n\r\n');
			});
			let text = '';
			socket.on('data', (data) => { text += data; });
			socket.on('end', () => resolve(text));
			socket.on('error', reject);
		});
		assert.match(response, /^HTTP\/1.1 403/);
	} finally { await gateway.close(); }
});
