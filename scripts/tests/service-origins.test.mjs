/**
 * Disposable root-origin regressions. Build first; no Docker or Tailscale is used.
 * SERVICE_ORIGIN_BUILD_DIR permits testing isolated transpiled server modules.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const base = process.env.SERVICE_ORIGIN_BUILD_DIR
	? pathToFileURL(resolve(process.env.SERVICE_ORIGIN_BUILD_DIR) + '/')
	: new URL('../../build/lib/server/', import.meta.url);
const { createServiceOriginServer } = await import(new URL('serviceOriginGateway.js', base));
const { parseServiceOrigins, findServiceOrigin } = await import(new URL('serviceOriginConfig.js', base));
const {
	issueServiceLaunch, exchangeServiceLaunch, serviceCookiePrefix, isServiceSessionValid
} = await import(new URL('serviceOriginAuth.js', base));
const { createSession, revokeSession } = await import(new URL('auth.js', base));
const { isDashboardRequestAllowed } = await import(new URL('dashboardRequestPolicy.js', base));
const DASHBOARD = 'https://dashboard.example';
const ROUTE = {
	origin: `${DASHBOARD}:8443`,
	listenPort: 4301,
	containerId: 'a'.repeat(64),
	containerPort: '4096'
};
const OTHER = { ...ROUTE, origin: `${DASHBOARD}:8444`, listenPort: 4302, containerId: 'b'.repeat(64) };
const connections = new WeakMap();

/** Listen on an ephemeral loopback port with bounded fixture startup. */
async function listen(server) {
	const sockets = new Set();
	connections.set(server, sockets);
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	return server.address().port;
}

/** Close keepalive connections and wait for listener teardown. */
async function close(server) {
	for (const socket of connections.get(server) ?? []) socket.destroy();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
}

/** Read the fragment bearer value without sending it in an HTTP URL. */
function ticket(route, parent, now) {
	return new URL(issueServiceLaunch(route, parent, now)).hash.slice(1);
}

/** Exchange through the actual HTTP control handler. */
async function login(f) {
	const response = await fetch(`${f.url}/__ddash/session`, {
		method: 'POST',
		headers: { origin: ROUTE.origin },
		body: ticket(ROUTE, f.parent)
	});
	assert.equal(response.status, 204);
	assert.match(response.headers.getSetCookie()[0], /HttpOnly; Secure; SameSite=Strict/);
	return response.headers.getSetCookie()[0].split(';')[0];
}

/** Start isolated upstream and gateway listeners; never inspect a real Docker daemon. */
async function fixture(t, handler, options = {}) {
	const upstream = createServer(handler);
	const upstreamPort = await listen(upstream);
	let stopped = false;
	let inspections = 0;
	let publishedPort = upstreamPort;
	const parent = createSession();
	const server = createServiceOriginServer({
		route: ROUTE,
		dashboardOrigin: DASHBOARD,
		inspect: async () => {
			inspections++;
			return {
				Id: ROUTE.containerId,
				State: { Running: !stopped },
				NetworkSettings: {
					Ports: { '4096/tcp': [{ HostIp: '127.0.0.1', HostPort: String(publishedPort) }] }
				}
			};
		},
		upstreamHost: '127.0.0.1',
		connectTimeoutMs: 200,
		leaseMs: 20,
		...options
	});
	const port = await listen(server);
	t.after(async () => {
		revokeSession(parent);
		await close(server);
		await close(upstream);
	});
	return {
		server, upstream, port, parent, url: `http://127.0.0.1:${port}`,
		inspections: () => inspections,
		stop: () => { stopped = true; },
		changePort: (port) => { publishedPort = port; }
	};
}

/** Send raw upgrade bytes, then destroy the client after recording the handshake. */
function upgrade(port, cookie, origin = ROUTE.origin) {
	return new Promise((resolve, reject) => {
		const socket = connect(port, '127.0.0.1');
		let text = '';
		socket.setTimeout(2000, () => socket.destroy(new Error('Upgrade timeout')));
		socket.on('error', reject);
		socket.on('data', (chunk) => {
			text += chunk;
			if (text.includes('fixture-ready') ||
				(!text.startsWith('HTTP/1.1 101') && text.includes('\r\n\r\n'))) {
				socket.destroy();
				resolve(text);
			}
		});
		socket.once('connect', () => socket.write(
			`GET /api/terminal/ws HTTP/1.1\r\nHost: dashboard.example:8443\r\n` +
			`Origin: ${origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
		));
	});
}

 test('validates explicit configuration and resolves UI short IDs', () => {
	assert.deepEqual(parseServiceOrigins(JSON.stringify([ROUTE, OTHER]), DASHBOARD), [ROUTE, OTHER]);
	assert.deepEqual(findServiceOrigin([ROUTE], 'a'.repeat(12), '4096'), ROUTE);
	assert.equal(findServiceOrigin([ROUTE], 'http://evil', '4096'), undefined);
	assert.deepEqual(parseServiceOrigins(undefined, ''), []);
	for (const entries of [
		[ROUTE, ROUTE],
		[{ ...ROUTE, origin: DASHBOARD }],
		[{ ...ROUTE, origin: 'http://dashboard.example:8443' }],
		[{ ...ROUTE, origin: 'https://other.example:8443' }],
		[{ ...ROUTE, origin: `${ROUTE.origin}/` }],
		[{ ...ROUTE, containerId: 'a'.repeat(12) }],
		[{ ...ROUTE, containerPort: '65536' }],
		[{ ...ROUTE, listenPort: 80 }]
	]) assert.throws(() => parseServiceOrigins(JSON.stringify(entries), DASHBOARD));
	assert.throws(() => parseServiceOrigins(JSON.stringify([ROUTE]), 'http://dashboard.example'));
});

 test('launch tickets are origin-bound, single-use, short-lived and parent-revocable', () => {
	const parent = createSession();
	const value = ticket(ROUTE, parent, 1000);
	assert.equal(exchangeServiceLaunch(OTHER, value, 1001), undefined);
	const session = exchangeServiceLaunch(ROUTE, value, 1001);
	assert.ok(session);
	assert.equal(exchangeServiceLaunch(ROUTE, value, 1002), undefined);
	const cookie = `${serviceCookiePrefix(ROUTE)}session=${session}`;
	assert.equal(isServiceSessionValid(ROUTE, cookie, 1002), true);
	assert.equal(isServiceSessionValid(OTHER, cookie, 1002), false);
	assert.equal(isServiceSessionValid(ROUTE, `${cookie}; ${cookie}`, 1002), false);
	const expired = ticket(ROUTE, parent, 1000);
	assert.equal(exchangeServiceLaunch(ROUTE, expired, 31000), undefined);
	revokeSession(parent);
	assert.equal(isServiceSessionValid(ROUTE, cookie, 31001), false);
	assert.throws(() => issueServiceLaunch(ROUTE, parent));
});

 test('service sessions expire after eight hours even with an active parent', () => {
	const parent = createSession();
	const token = exchangeServiceLaunch(ROUTE, ticket(ROUTE, parent, 1000), 1001);
	const cookie = `${serviceCookiePrefix(ROUTE)}session=${token}`;
	assert.equal(isServiceSessionValid(ROUTE, cookie, 1002), true);
	assert.equal(isServiceSessionValid(ROUTE, cookie, 1001 + 8 * 3600000), false);
	revokeSession(parent);
});

 test('blocks sibling-origin dashboard writes, fetches, resources and frames', () => {
	const allowed = (method, headers) => isDashboardRequestAllowed(method, new Headers(headers), DASHBOARD);
	assert.equal(allowed('POST', { origin: ROUTE.origin }), false);
	assert.equal(allowed('GET', { origin: ROUTE.origin }), false);
	assert.equal(allowed('GET', {
		'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script'
	}), false);
	assert.equal(allowed('GET', { 'sec-fetch-dest': 'iframe' }), false);
	assert.equal(allowed('POST', {}), false);
	assert.equal(allowed('POST', { origin: DASHBOARD }), true);
	assert.equal(allowed('GET', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' }), true);
	assert.equal(allowed('GET', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }), true);
});

 test('authenticates assets and APIs before any Docker access', async (t) => {
	const f = await fixture(t, (_req, res) => res.end('unexpected'));
	for (const path of ['/', '/_assets/main.js', '/api/session', '/api/event']) {
		assert.equal((await fetch(f.url + path)).status, 401);
	}
	assert.equal(f.inspections(), 0);
});

 test('serves a no-store fragment bridge and rejects invalid ticket exchanges', async (t) => {
	const f = await fixture(t, (_req, res) => res.end());
	const bridge = await fetch(`${f.url}/__ddash/launch`);
	assert.equal(bridge.status, 200);
	assert.equal(bridge.headers.get('cache-control'), 'no-store');
	assert.match(bridge.headers.get('content-security-policy'), /frame-ancestors https:\/\/dashboard.example/);
	assert.match(await bridge.text(), /history.replaceState/);
	assert.equal((await fetch(`${f.url}/__ddash/session`, {
		method: 'POST', headers: { origin: DASHBOARD }, body: ticket(ROUTE, f.parent)
	})).status, 403);
	assert.equal((await fetch(`${f.url}/__ddash/session`, {
		method: 'POST', headers: { origin: ROUTE.origin }, body: 'x'.repeat(200)
	})).status, 400);
	assert.equal((await fetch(`${f.url}/__ddash/session`, {
		method: 'POST', headers: { origin: ROUTE.origin }, body: 'x'.repeat(43)
	})).status, 401);
	const cookie = await login(f);
	assert.match(cookie, /^__Secure-ddash-svc-/);
	assert.equal(f.inspections(), 0);
});

 test('preserves root asset/API paths, streams uploads and strips sibling credentials', async (t) => {
	let received;
	const f = await fixture(t, async (req, res) => {
		const parts = [];
		for await (const part of req) parts.push(part);
		received = { url: req.url, headers: req.headers, body: Buffer.concat(parts).toString() };
		res.end('ok');
	});
	const cookie = await login(f);
	const response = await fetch(`${f.url}/api/upload?q=a%2Fb`, {
		method: 'POST',
		headers: {
			origin: ROUTE.origin,
			authorization: 'Bearer dashboard-secret',
			cookie: `${cookie}; devcontainer-dashboard-session=secret; ` +
				`${serviceCookiePrefix(OTHER)}session=sibling; ignored=value; ` +
				`${serviceCookiePrefix(ROUTE)}app_sid=app-session`
		},
		body: 'upload-body'
	});
	assert.equal(response.status, 200);
	assert.equal(received.url, '/api/upload?q=a%2Fb');
	assert.equal(received.body, 'upload-body');
	assert.equal(received.headers.cookie, 'sid=app-session');
	assert.equal(received.headers.authorization, undefined);
	assert.equal(received.headers.origin, ROUTE.origin);
	assert.equal(received.headers.host, 'dashboard.example:8443');
	assert.equal(received.headers['x-forwarded-proto'], 'https');
	assert.equal(received.headers['x-forwarded-prefix'], undefined);
	assert.equal((await fetch(`${f.url}/_assets/main.js`, { headers: { cookie } })).status, 200);
	assert.equal(received.url, '/_assets/main.js');
});

 test('namespaces app cookies and preserves frame protections and confined root redirects', async (t) => {
	const f = await fixture(t, (_req, res) => {
		res.writeHead(302, {
			location: '/login?q=1',
			'set-cookie': ['sid=x; Domain=example; Path=/api; HttpOnly',
				'devcontainer-dashboard-session=evil; Path=/',
				`${serviceCookiePrefix(ROUTE)}session=evil; Path=/`],
			'x-frame-options': 'SAMEORIGIN',
			'content-security-policy': "frame-ancestors 'self'",
			'access-control-allow-origin': '*',
			'clear-site-data': '"cookies"',
			'alt-svc': 'h3=":443"'
		});
		res.end();
	});
	const cookie = await login(f);
	const response = await fetch(f.url, { headers: { cookie }, redirect: 'manual' });
	assert.equal(response.status, 302);
	assert.equal(response.headers.get('location'), '/login?q=1');
	assert.deepEqual(response.headers.getSetCookie(), [
		`${serviceCookiePrefix(ROUTE)}app_sid=x; HttpOnly;Path=/;Secure;SameSite=Strict`
	]);
	assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
	assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'self'");
	assert.equal(response.headers.get('access-control-allow-origin'), null);
	assert.equal(response.headers.get('clear-site-data'), null);
	assert.equal(response.headers.get('alt-svc'), null);
});

 test('rejects foreign Origin, service workers, traversal and stopped containers', async (t) => {
	const f = await fixture(t, (_req, res) => res.end('ok'));
	const cookie = await login(f);
	assert.equal((await fetch(f.url, { headers: { cookie, origin: OTHER.origin } })).status, 403);
	assert.equal((await fetch(f.url, { headers: { cookie, 'service-worker': 'script' } })).status, 403);
	assert.equal((await fetch(f.url + '/a%2fb', { headers: { cookie } })).status, 400);
	assert.equal((await fetch(f.url, { headers: { cookie } })).status, 200);
	f.stop();
	assert.equal((await fetch(f.url, { headers: { cookie } })).status, 409);
});

 test('discovers changed published ports rather than caching a random host port', async (t) => {
	const f = await fixture(t, (_req, res) => res.end('first'));
	const next = createServer((_req, res) => res.end('second'));
	const port = await listen(next);
	t.after(() => close(next));
	const cookie = await login(f);
	assert.equal(await (await fetch(f.url, { headers: { cookie } })).text(), 'first');
	f.changePort(port);
	assert.equal(await (await fetch(f.url, { headers: { cookie } })).text(), 'second');
});

 test('streams SSE without waiting for completion and revokes live access after logout', async (t) => {
	const f = await fixture(t, (_req, res) => {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write('data: live\n\n');
	});
	const cookie = await login(f);
	const response = await fetch(f.url + '/api/event', { headers: { cookie } });
	const reader = response.body.getReader();
	assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: live\n\n');
	revokeSession(f.parent);
	await assert.rejects(reader.read());
	assert.equal((await fetch(f.url, { headers: { cookie } })).status, 401);
});

 test('authenticates upgrades and preserves the original root WebSocket path', async (t) => {
	let received;
	const f = await fixture(t, (_req, res) => res.end());
	f.upstream.on('upgrade', (req, socket) => {
		received = req;
		socket.on('error', () => {});
		socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n' +
			'Upgrade: websocket\r\n\r\nfixture-ready');
	});
	assert.match(await upgrade(f.port, ''), /^HTTP\/1.1 401/);
	assert.equal(f.inspections(), 0);
	const cookie = await login(f);
	assert.match(await upgrade(f.port, cookie, OTHER.origin), /^HTTP\/1.1 403/);
	assert.match(await upgrade(f.port, cookie), /101 Switching Protocols[\s\S]*fixture-ready/);
	assert.equal(received.url, '/api/terminal/ws');
	assert.equal(received.headers.cookie, undefined);
	assert.equal(received.headers.origin, ROUTE.origin);
});

 test('closes an established upgraded connection after parent logout', async (t) => {
	const f = await fixture(t, (_req, res) => res.end());
	f.upstream.on('upgrade', (_req, socket) => {
		socket.on('error', () => {});
		socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n' +
			'Upgrade: websocket\r\n\r\nfixture-ready');
	});
	const cookie = await login(f);
	await new Promise((resolve, reject) => {
		const socket = connect(f.port, '127.0.0.1');
		let opened = false;
		let data = '';
		socket.setTimeout(2000, () => socket.destroy(new Error('Logout did not close upgrade')));
		socket.on('error', reject);
		socket.on('data', (chunk) => {
			data += chunk;
			if (data.includes('fixture-ready') && !opened) {
				opened = true;
				revokeSession(f.parent);
			}
		});
		socket.once('close', () => {
			try { assert.equal(opened, true); resolve(); }
			catch (error) { reject(error); }
		});
		socket.once('connect', () => socket.write(
			`GET /api/event/ws HTTP/1.1\r\nHost: dashboard.example:8443\r\n` +
			`Origin: ${ROUTE.origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
		));
	});
});
