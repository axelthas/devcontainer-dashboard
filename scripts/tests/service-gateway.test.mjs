/**
 * Disposable HTTP/upgrade regressions for the compiled service gateway.
 * Run both builds first, then node --test scripts/tests/service-gateway.test.mjs.
 * GATEWAY_MODULE_URL permits an isolated transpiled-module test without an app build.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';

const { createServiceGateway, parseServicePath, cleanHeaders } = await import(
	process.env.GATEWAY_MODULE_URL ?? '../../build/lib/server/serviceGateway.js'
);
const ID = 'abcdef123456';
const PREFIX = `/service-proxy/${ID}/9001/`;
const ORIGIN = 'https://dashboard.example';
const AUTH = 'devcontainer-dashboard-session=valid';

/** Listen on an ephemeral loopback port without touching Docker or real services. */
async function listen(server) {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return server.address().port;
}

/** Close HTTP connections retained by fetch keepalive and wait for the listener. */
async function close(server) {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
}

/** Make fake Docker metadata refer to one disposable HTTP server. */
function inspection(port, changes = {}) {
	return {
		Id: ID + 'a'.repeat(52),
		State: { Running: true },
		NetworkSettings: {
			Ports: { '9001/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] },
			Networks: { fixture: { IPAddress: '127.0.0.1' } }
		},
		...changes
	};
}

/** Run a gateway and upstream fixture and register deterministic teardown. */
async function fixture(t, handler, options = {}) {
	const upstream = createServer(handler);
	const upstreamPort = await listen(upstream);
	let inspections = 0;
	const gateway = createServiceGateway({
		inspect: async () => {
			inspections++;
			return inspection(upstreamPort);
		},
		authenticated: (cookie) => cookie?.includes(AUTH) ?? false,
		origin: ORIGIN,
		upstreamHost: '127.0.0.1',
		connectTimeoutMs: 100,
		...options
	});
	const server = createServer((req, res) => {
		if (gateway.matches(req.url)) void gateway.handle(req, res);
		else {
			res.writeHead(404);
			res.end();
		}
	});
	server.on('upgrade', (req, socket, head) => {
		if (gateway.matches(req.url)) void gateway.upgrade(req, socket, head);
		else socket.destroy();
	});
	const port = await listen(server);
	t.after(async () => {
		await close(server);
		await close(upstream);
	});
	return {
		server,
		upstream,
		port,
		url: `http://127.0.0.1:${port}`,
		inspections: () => inspections
	};
}

/** Send raw upgrade bytes and collect the initial response, with a bounded timeout. */
function upgrade(port, path, { cookie = AUTH, origin = ORIGIN } = {}) {
	return new Promise((resolve, reject) => {
		const socket = connect(port, '127.0.0.1');
		let result = '';
		socket.setTimeout(2000, () => socket.destroy(new Error('upgrade fixture timeout')));
		socket.on('error', reject);
		socket.on('data', (data) => {
			result += data;
			if (
				result.includes('fixture-ready') ||
				(!result.startsWith('HTTP/1.1 101') && result.includes('\r\n\r\n'))
			) {
				socket.destroy();
				resolve(result);
			}
		});
		socket.on('connect', () =>
			socket.write(
				`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\nOrigin: ${origin}\r\n\r\n`
			)
		);
	});
}

test('parses identity, paths, and query strings without changing encoded query data', () => {
	assert.deepEqual(parseServicePath(`${PREFIX}events?q=a%2Fb`), {
		id: ID,
		port: '9001',
		path: '/events?q=a%2Fb',
		prefix: PREFIX
	});
	assert.equal(parseServicePath('/api/terminal'), null);
});

test('rejects traversal, invalid ports, URL targets, encoded separators, and controls', () => {
	for (const path of [
		`${PREFIX}../api`,
		`${PREFIX}%2e%2e/api`,
		`${PREFIX}%252e/api`,
		`${PREFIX}a%2fb`,
		`${PREFIX}a%5cb`,
		`${PREFIX}%00`,
		`${PREFIX}/evil`,
		`${PREFIX}%zz`,
		`/service-proxy/${ID}/65536/`,
		'/service-proxy/http://evil/9001/'
	])
		assert.throws(() => parseServicePath(path), undefined, path);
});

test('removes hop-by-hop and forwarded header spoofing', () => {
	assert.deepEqual(
		cleanHeaders({
			connection: 'x-secret',
			'x-secret': 'hidden',
			'x-forwarded-for': 'spoof',
			accept: 'text/plain'
		}),
		{ accept: 'text/plain' }
	);
});

test('authenticates before inspecting Docker or contacting an upstream', async (t) => {
	const f = await fixture(t, (_req, res) => res.end('unexpected'));
	assert.equal((await fetch(f.url + PREFIX)).status, 401);
	assert.equal(f.inspections(), 0);
});

test('requires exact origin on mutations and never forwards dashboard credentials', async (t) => {
	let received;
	const f = await fixture(t, async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		received = { headers: req.headers, body: Buffer.concat(chunks).toString(), path: req.url };
		res.end('ok');
	});
	assert.equal(
		(await fetch(f.url + PREFIX, { method: 'POST', headers: { cookie: AUTH }, body: 'bad' }))
			.status,
		403
	);
	const response = await fetch(f.url + PREFIX + 'action?q=1', {
		method: 'POST',
		headers: {
			cookie: `${AUTH}; service=allowed`,
			origin: ORIGIN,
			authorization: 'Bearer private',
			referer: ORIGIN,
			'x-forwarded-host': 'spoof'
		},
		body: 'action-body'
	});
	assert.equal(response.status, 200);
	assert.equal(received.body, 'action-body');
	assert.equal(received.path, '/action?q=1');
	assert.equal(received.headers.cookie.trim(), 'service=allowed');
	assert.equal(received.headers.authorization, undefined);
	assert.equal(received.headers.referer, undefined);
	assert.equal(received.headers.origin, undefined);
	assert.equal(received.headers['x-forwarded-host'], undefined);
	assert.equal(received.headers['x-forwarded-prefix'], PREFIX.slice(0, -1));
});

test('rewrites redirects and confines cookies without removing frame protections', async (t) => {
	const f = await fixture(t, (_req, res) => {
		res.writeHead(302, {
			location: '/login?q=1',
			'set-cookie': [
				'service=x; Domain=example.com; Path=/; HttpOnly',
				'devcontainer-dashboard-session=evil; Path=/',
				'__Host-root=evil; Path=/; Secure'
			],
			'x-frame-options': 'DENY',
			'content-security-policy': "frame-ancestors 'none'"
		});
		res.end();
	});
	const response = await fetch(f.url + PREFIX, { headers: { cookie: AUTH }, redirect: 'manual' });
	assert.equal(response.headers.get('location'), PREFIX + 'login?q=1');
	assert.deepEqual(response.headers.getSetCookie(), [`service=x; HttpOnly;Path=${PREFIX}`]);
	assert.equal(response.headers.get('x-frame-options'), 'DENY');
	assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'");
});

test('rejects external redirects without forwarding them', async (t) => {
	const f = await fixture(t, (_req, res) => {
		res.writeHead(302, { location: 'https://evil.example/' });
		res.end();
	});
	const response = await fetch(f.url + PREFIX, { headers: { cookie: AUTH }, redirect: 'manual' });
	assert.equal(response.status, 502);
	assert.equal(response.headers.get('location'), null);
});

test('rejects stopped, missing, unbound, and mismatched containers', async (t) => {
	for (const [info, expected] of [
		[inspection(1, { State: { Running: false } }), 409],
		[inspection(1, { Id: 'f'.repeat(64) }), 409],
		[inspection(1, { NetworkSettings: { Ports: {} } }), 404],
		[null, 404]
	]) {
		const f = await fixture(t, (_req, res) => res.end(), {
			inspect: async () => {
				if (!info) throw new Error('private Docker detail');
				return info;
			}
		});
		assert.equal((await fetch(f.url + PREFIX, { headers: { cookie: AUTH } })).status, expected);
	}
});

test('does not treat database ports as web services', async (t) => {
	const f = await fixture(t, (_req, res) => res.end());
	assert.equal(
		(await fetch(f.url + PREFIX.replace('/9001/', '/5432/'), { headers: { cookie: AUTH } })).status,
		422
	);
	assert.equal(f.inspections(), 0);
});

test('fails ambiguous network selection instead of choosing a random address', async (t) => {
	const f = await fixture(t, (_req, res) => res.end(), {
		upstreamHost: undefined,
		inspect: async () =>
			inspection(1, {
				NetworkSettings: {
					Ports: { '9001/tcp': [{ HostIp: '0.0.0.0', HostPort: '9001' }] },
					Networks: { a: { IPAddress: '172.18.0.2' }, b: { IPAddress: '172.19.0.2' } }
				}
			})
	});
	assert.equal((await fetch(f.url + PREFIX, { headers: { cookie: AUTH } })).status, 503);
});

test('streams SSE before the upstream finishes and preserves status', async (t) => {
	const f = await fixture(t, (_req, res) => {
		res.writeHead(201, { 'Content-Type': 'text/event-stream' });
		res.write('data: first\n\n');
		res.once('close', () => res.end());
	});
	const controller = new AbortController();
	t.after(() => controller.abort());
	const response = await fetch(f.url + PREFIX, {
		headers: { cookie: AUTH },
		signal: controller.signal
	});
	assert.equal(response.status, 201);
	assert.equal(
		new TextDecoder().decode((await response.body.getReader().read()).value),
		'data: first\n\n'
	);
	controller.abort();
});

test('returns bounded errors for an upstream header timeout', async (t) => {
	const f = await fixture(t, () => {});
	const response = await fetch(f.url + PREFIX, { headers: { cookie: AUTH } });
	assert.equal(response.status, 502);
	assert.match(await response.text(), /unreachable/);
});

test('rejects unauthorized and cross-origin upgrades before Docker access', async (t) => {
	const f = await fixture(t, (_req, res) => res.end());
	assert.match(await upgrade(f.port, PREFIX, { cookie: '' }), /^HTTP\/1.1 401/);
	assert.match(await upgrade(f.port, PREFIX, { origin: 'https://evil.example' }), /^HTTP\/1.1 403/);
	assert.equal(f.inspections(), 0);
});

test('tunnels upgrade head bytes without leaking dashboard cookies', async (t) => {
	let headers;
	const f = await fixture(t, (_req, res) => res.end());
	f.upstream.on('upgrade', (req, socket) => {
		headers = req.headers;
		socket.on('error', () => {});
		socket.end(
			'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: fixture\r\n\r\nfixture-ready'
		);
	});
	assert.match(await upgrade(f.port, PREFIX), /101 Switching Protocols[\s\S]*fixture-ready/);
	assert.equal(headers.cookie, undefined);
});

test('leaves terminal and unrelated paths to their existing handlers', async (t) => {
	const f = await fixture(t, (_req, res) => res.end());
	assert.equal((await fetch(f.url + '/api/terminal')).status, 404);
	assert.equal(f.inspections(), 0);
});

test('revalidates Docker state after a previously successful request', async (t) => {
	let stopped = false;
	let port;
	const f = await fixture(t, (_req, res) => res.end('ok'), {
		inspect: async () => inspection(port, { State: { Running: !stopped } })
	});
	port = f.upstream.address().port;
	assert.equal((await fetch(f.url + PREFIX, { headers: { cookie: AUTH } })).status, 200);
	stopped = true;
	assert.equal((await fetch(f.url + PREFIX, { headers: { cookie: AUTH } })).status, 409);
});

test('bounds a stalled Docker lookup', async (t) => {
	const f = await fixture(t, (_req, res) => res.end(), {
		inspect: () => new Promise(() => {})
	});
	const response = await fetch(f.url + PREFIX, { headers: { cookie: AUTH } });
	assert.equal(response.status, 404);
	assert.equal(await response.text(), 'Container is no longer available.');
});

test('does not propagate upstream cross-origin grants', async (t) => {
	const f = await fixture(t, (_req, res) => {
		res.writeHead(200, {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Credentials': 'true',
			'Service-Worker-Allowed': '/'
		});
		res.end('ok');
	});
	const response = await fetch(f.url + PREFIX, { headers: { cookie: AUTH } });
	assert.equal(response.headers.get('access-control-allow-origin'), null);
	assert.equal(response.headers.get('access-control-allow-credentials'), null);
	assert.equal(response.headers.get('service-worker-allowed'), null);
});
