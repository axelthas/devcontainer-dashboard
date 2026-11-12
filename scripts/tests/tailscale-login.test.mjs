/**
 * Reproduce service-level Basic authentication behind the dashboard session gate.
 * Use real disposable HTTP listeners with fake Docker/LocalAPI state; install nothing.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { allocateServePort } from '../../src/lib/server/tailscaleServe.ts';
import { startTailscaleServices } from '../../src/lib/server/tailscaleServiceRuntime.ts';

const id = 'a'.repeat(64);
const origin = 'https://node.example.ts.net:8400';
const cookie = 'devcontainer-dashboard-session=dashboard-secret';
const authorization = `Basic ${Buffer.from('opencode:service-password').toString('base64')}`;

/** Bind a server to an available loopback port and return its address. */
async function bind(server) {
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	return server.address().port;
}

/** Exercise the runtime's real HTTP proxy while recording what the service receives. */
async function fixture(t, ports = { 4096: 'http' }) {
	const directory = await mkdtemp(join(tmpdir(), 'ddash-login-'));
	let config = {};
	const received = [];
	const upstream = http.createServer((req, res) => {
		received.push(req.headers);
		if (req.headers.authorization !== authorization) {
			res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="OpenCode"' }).end();
		} else res.end('{"healthy":true}');
	});
	const hostPort = await bind(upstream);
	const reservation = http.createServer();
	const listenPort = await bind(reservation);
	await new Promise((resolve) => reservation.close(resolve));
	const runtime = await startTailscaleServices({
		settings: {
			socket: '/not-used',
			origin: 'https://node.example.ts.net',
			hostname: 'node.example.ts.net',
			first: 8400,
			last: 8410,
			listenPort,
			stateFile: join(directory, 'state.json')
		},
		client: {
			get: async () => ({ config: structuredClone(config), etag: '"1"' }),
			update: async (merge) => {
				const next = await merge(structuredClone(config));
				if (next) config = next;
				return config;
			}
		},
		allocate: allocateServePort,
		inspect: async () => ({
			Id: id,
			State: { Running: true },
			NetworkSettings: {
				Ports: {
					'4096/tcp': [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }],
					'3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }]
				}
			}
		}),
		authenticated: (header) => header === cookie,
		ports
	});
	t.after(async () => {
		await runtime.close();
		await new Promise((resolve) => upstream.close(resolve));
		await rm(directory, { recursive: true, force: true });
	});

	/** Issue a browser-like request to the local origin gateway. */
	function request(headers = {}) {
		return new Promise((resolve, reject) => {
			const req = http.get(
				{
					host: '127.0.0.1',
					port: listenPort,
					path: '/api/global/health',
					headers: { host: new URL(origin).host, cookie, authorization, ...headers }
				},
				(res) => {
					res.resume();
					res.on('end', () => resolve(res.statusCode));
				}
			);
			req.on('error', reject);
		});
	}
	return { runtime, received, request };
}

test('OpenCode service login forwards explicit same-origin Basic auth, never the dashboard cookie', async (t) => {
	const f = await fixture(t);
	await f.runtime.ensure(id, '4096');
	for (const context of [{ 'sec-fetch-site': 'same-origin' }, { origin }]) {
		assert.equal(await f.request(context), 200);
		assert.equal(f.received.at(-1).authorization, authorization);
		assert.equal(f.received.at(-1).cookie, undefined);
	}
	for (const context of [{}, { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' }]) {
		assert.equal(await f.request(context), 401);
		assert.equal(f.received.at(-1).authorization, undefined);
	}
	assert.equal(await f.request({ origin: 'https://node.example.ts.net' }), 403);
	assert.equal(await f.request({ cookie: '', 'sec-fetch-site': 'same-origin' }), 403);
	assert.equal(
		await f.request({
			authorization: 'Bearer not-service-basic',
			'sec-fetch-site': 'same-origin'
		}),
		401
	);
});

test('OpenChamber container port 3000 is enabled for dedicated origins by default', async (t) => {
	const f = await fixture(t);
	assert.equal(await f.runtime.ensure(id, '3000'), origin);
	assert.equal(await f.request({ origin }), 200);
	const mapping = await readFile(new URL('../../src/lib/portConfig.ts', import.meta.url), 'utf8');
	assert.match(mapping, /'3000':\s*\{\s*label: 'OpenChamber'/);
});

test('an explicit operator off still disables OpenChamber', async (t) => {
	const f = await fixture(t, { 4096: 'http', 3000: 'off' });
	await assert.rejects(f.runtime.ensure(id, '3000'), /disabled web service/);
});
