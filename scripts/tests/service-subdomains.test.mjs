// Disposable regressions for wildcard service subdomains. Build both outputs first.
//
// Usage: node --test scripts/tests/service-subdomains.test.mjs (Node 22).
// A plain HTTP fixture stands in for the HTTPS listener; no Docker, TLS or Tailscale is
// used. SERVICE_SUBDOMAIN_BUILD_DIR can point at isolated transpiled server modules.

import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const base = process.env.SERVICE_SUBDOMAIN_BUILD_DIR
	? pathToFileURL(`${resolve(process.env.SERVICE_SUBDOMAIN_BUILD_DIR)}/`)
	: new URL('../../build/lib/server/', import.meta.url);
const load = (name) => import(new URL(name, base));
const { createSubdomainGateway } = await load('serviceSubdomainGateway.js');
const subdomains = await load('serviceSubdomains.js');
const { parseSubdomainConfig, parseServiceHost, serviceOrigin } = subdomains;
const auth = await load('serviceOriginAuth.js');
const { createSession, revokeSession } = await load('auth.js');

const DASHBOARD = 'https://host.tailnet.ts.net';
const NODE = 'host.tailnet.ts.net';
const CONFIG = parseSubdomainConfig({ SERVICE_SUBDOMAIN_BASE: NODE, ORIGIN: DASHBOARD });
const SHORT = 'a'.repeat(12);
const ID = SHORT + 'b'.repeat(52);
const HOST = `4096-${SHORT}.${NODE}:8443`;
const ORIGIN = `https://${HOST}`;
const OTHER_HOST = `3000-${SHORT}.${NODE}:8443`;
const OTHER = `https://${OTHER_HOST}`;
const ROUTE = { origin: ORIGIN, containerId: ID, containerPort: '4096' };
const sockets = new WeakMap();

// Listen on an ephemeral loopback port and track sockets for teardown.
async function listen(server) {
	const open = new Set();
	sockets.set(server, open);
	server.on('connection', (socket) => {
		open.add(socket);
		socket.once('close', () => open.delete(socket));
	});
	await new Promise((done, fail) => {
		server.once('error', fail);
		server.listen(0, '127.0.0.1', done);
	});
	return server.address().port;
}

// Destroy live sockets and wait for listener teardown.
async function close(server) {
	for (const socket of sockets.get(server) ?? []) socket.destroy();
	await new Promise((done) => server.close(done));
}

// Return the fragment bearer value of a new launch ticket.
function ticket(route, parent) {
	return new URL(auth.issueServiceLaunch(route, parent)).hash.slice(1);
}

// Start an upstream and the gateway with fake Docker metadata; never touch a daemon.
async function fixture(t, handler) {
	const upstream = createServer(handler);
	const upstreamPort = await listen(upstream);
	const state = { running: true, id: ID, port: upstreamPort, inspections: 0 };
	const parent = createSession();
	const gateway = createSubdomainGateway({
		config: CONFIG,
		inspect: async () => {
			state.inspections++;
			const binding = [{ HostIp: '127.0.0.1', HostPort: String(state.port) }];
			return {
				Id: state.id,
				State: { Running: state.running },
				NetworkSettings: { Ports: { '4096/tcp': binding } }
			};
		},
		upstreamHost: '127.0.0.1',
		connectTimeoutMs: 200,
		leaseMs: 20
	});
	const server = createServer(gateway.handle);
	server.on('upgrade', gateway.upgrade);
	const port = await listen(server);
	t.after(async () => {
		revokeSession(parent);
		await close(server);
		await close(upstream);
	});
	return { upstream, port, parent, state };
}

// Send one request with an explicit Host header, as the TLS listener receives it.
function send(f, path, { host = HOST, method = 'GET', headers = {}, body } = {}) {
	return new Promise((done, fail) => {
		const target = { host: '127.0.0.1', port: f.port, path, method };
		const req = httpRequest({ ...target, headers: { host, ...headers } }, (res) => {
			const chunks = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString();
				done({ status: res.statusCode, headers: res.headers, text });
			});
		});
		req.on('error', fail);
		req.end(body);
	});
}

// Post a launch ticket body to the exchange route.
function post(f, origin, body) {
	return send(f, '/__ddash/session', { method: 'POST', headers: { origin }, body });
}

// Post a launch ticket body to the exchange route and return the response status.
async function exchange(f, origin, body) {
	return (await post(f, origin, body)).status;
}

// Exchange a ticket through the real control route and return the session cookie pair.
async function login(f) {
	const res = await post(f, ORIGIN, ticket(ROUTE, f.parent));
	assert.equal(res.status, 204);
	const cookie = res.headers['set-cookie'][0];
	assert.match(cookie, /^__Host-ddash-service-session=[\w-]+;/);
	assert.match(cookie, /; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
	return cookie.split(';')[0];
}

// Write a raw upgrade request and resolve with the handshake text.
function upgrade(f, cookie, origin = ORIGIN) {
	return new Promise((done, fail) => {
		const socket = connect(f.port, '127.0.0.1');
		let text = '';
		socket.setTimeout(2000, () => socket.destroy(new Error('Upgrade timeout')));
		socket.on('error', fail);
		socket.on('data', (chunk) => {
			text += chunk;
			const refused = !text.startsWith('HTTP/1.1 101') && text.includes('\r\n\r\n');
			if (text.includes('fixture-ready') || refused) {
				socket.destroy();
				done(text);
			}
		});
		socket.once('connect', () =>
			socket.write(
				`GET /api/terminal/ws HTTP/1.1\r\nHost: ${HOST}\r\nOrigin: ${origin}\r\n` +
					`Cookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
			)
		);
	});
}

test('validates configuration and parses only one-label service hosts', () => {
	assert.equal(parseSubdomainConfig({}), undefined);
	assert.equal(CONFIG.publicPort, 8443);
	for (const env of [
		{ ORIGIN: `http://${NODE}` },
		{ ORIGIN: 'https://other.tailnet.ts.net' },
		{ ORIGIN: `${DASHBOARD}/` },
		{ ORIGIN: DASHBOARD, SERVICE_SUBDOMAIN_BASE: 'bad_name' },
		{ ORIGIN: DASHBOARD, SERVICE_SUBDOMAIN_PUBLIC_PORT: '70000' }
	]) {
		assert.throws(() => parseSubdomainConfig({ SERVICE_SUBDOMAIN_BASE: NODE, ...env }));
	}
	const parsed = parseServiceHost(CONFIG, HOST);
	assert.deepEqual(parsed, { origin: ORIGIN, shortId: SHORT, containerPort: '4096' });
	assert.equal(parseServiceHost(CONFIG, HOST.toUpperCase()).origin, ORIGIN);
	for (const host of [
		`${NODE}:8443`,
		`4096-${SHORT}.${NODE}`,
		`4096-${SHORT}.${NODE}:443`,
		`x.4096-${SHORT}.${NODE}:8443`,
		`4096-${SHORT.slice(1)}.${NODE}:8443`,
		`70000-${SHORT}.${NODE}:8443`,
		`4096-${SHORT}.evil.example:8443`,
		`4096-${SHORT}.${NODE}.evil:8443`
	]) {
		assert.equal(parseServiceHost(CONFIG, host), undefined, host);
	}
	const env = { SERVICE_SUBDOMAIN_BASE: NODE, ORIGIN: DASHBOARD };
	const https = parseSubdomainConfig({ ...env, SERVICE_SUBDOMAIN_PUBLIC_PORT: '443' });
	assert.equal(serviceOrigin(https, SHORT, '4096'), `https://4096-${SHORT}.${NODE}`);
});

test('tickets are origin-bound, single-use and revoked with the dashboard session', () => {
	const parent = createSession();
	const value = ticket(ROUTE, parent);
	assert.equal(auth.exchangeServiceLaunch(OTHER, value), undefined);
	const session = auth.exchangeServiceLaunch(ORIGIN, value);
	assert.ok(session);
	assert.equal(auth.exchangeServiceLaunch(ORIGIN, value), undefined);
	const cookie = `${auth.SERVICE_SESSION_COOKIE}=${session}`;
	assert.deepEqual(auth.serviceSessionRoute(ORIGIN, cookie), ROUTE);
	assert.equal(auth.serviceSessionRoute(OTHER, cookie), undefined);
	assert.equal(auth.serviceSessionRoute(ORIGIN, `${cookie}; ${cookie}`), undefined);
	revokeSession(parent);
	assert.equal(auth.serviceSessionRoute(ORIGIN, cookie), undefined);
	assert.throws(() => auth.issueServiceLaunch(ROUTE, parent));
});

test('rejects unknown hosts and unauthenticated traffic before Docker access', async (t) => {
	const f = await fixture(t, (_req, res) => res.end('unexpected'));
	assert.equal((await send(f, '/', { host: 'evil.example' })).status, 421);
	for (const path of ['/', '/_assets/main.js', '/api/session']) {
		assert.equal((await send(f, path)).status, 401);
	}
	assert.equal(f.state.inspections, 0);
});

test('serves a no-store bridge and rejects foreign-origin or invalid exchanges', async (t) => {
	const f = await fixture(t, (_req, res) => res.end());
	const bridge = await send(f, '/__ddash/launch');
	assert.equal(bridge.status, 200);
	assert.equal(bridge.headers['cache-control'], 'no-store');
	assert.match(bridge.headers['content-security-policy'], /frame-ancestors https:\/\/host\./);
	assert.equal(await exchange(f, OTHER, ticket(ROUTE, f.parent)), 403);
	assert.equal(await exchange(f, ORIGIN, 'x'.repeat(43)), 401);
	assert.equal(await exchange(f, ORIGIN, 'x'.repeat(200)), 400);
	// A ticket issued for another subdomain cannot be exchanged here.
	assert.equal(await exchange(f, ORIGIN, ticket({ ...ROUTE, origin: OTHER }, f.parent)), 401);
});

test('proxies root paths, uploads and app cookies without gateway credentials', async (t) => {
	let seen;
	const f = await fixture(t, async (req, res) => {
		const parts = [];
		for await (const part of req) parts.push(part);
		seen = { url: req.url, headers: req.headers, body: Buffer.concat(parts).toString() };
		res.writeHead(200, {
			'set-cookie': ['sid=app; Domain=tailnet.ts.net; Path=/api; HttpOnly', '__Host-x=evil; Path=/']
		});
		res.end('ok');
	});
	const session = await login(f);
	const cookie = `${session}; devcontainer-dashboard-session=secret; sid=app`;
	const headers = { origin: ORIGIN, authorization: 'Bearer secret', cookie };
	const res = await send(f, '/api/upload?q=a%2Fb', { method: 'POST', headers, body: 'upload' });
	assert.equal(res.status, 200);
	assert.equal(seen.url, '/api/upload?q=a%2Fb');
	assert.equal(seen.body, 'upload');
	assert.equal(seen.headers.cookie.trim(), 'sid=app');
	assert.equal(seen.headers.authorization, undefined);
	assert.equal(seen.headers.host, HOST);
	assert.equal(seen.headers.origin, ORIGIN);
	assert.equal(seen.headers['x-forwarded-proto'], 'https');
	// Domain is removed so the cookie stays host-only; reserved names are dropped.
	assert.deepEqual(res.headers['set-cookie'], ['sid=app; Path=/api; HttpOnly']);
});

test('keeps encoded application paths and confines redirects to the service origin', async (t) => {
	const f = await fixture(t, (req, res) => {
		const location = req.url === '/away' ? 'https://evil.example/' : `${ORIGIN}/next?x=1`;
		res.writeHead(302, { location });
		res.end();
	});
	const cookie = await login(f);
	const local = await send(f, '/a%2Fb/%25', { headers: { cookie } });
	assert.equal(local.status, 302);
	assert.equal(local.headers.location, '/next?x=1');
	assert.equal((await send(f, '/away', { headers: { cookie } })).status, 502);
});

test('rejects foreign origins, service workers and sessions from another origin', async (t) => {
	const f = await fixture(t, (_req, res) => res.end('ok'));
	const cookie = await login(f);
	const sameSite = { cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' };
	const worker = { cookie, 'service-worker': 'script' };
	assert.equal((await send(f, '/', { headers: { cookie } })).status, 200);
	assert.equal((await send(f, '/', { headers: { cookie, origin: DASHBOARD } })).status, 403);
	assert.equal((await send(f, '/', { headers: worker })).status, 403);
	assert.equal((await send(f, '/', { headers: sameSite })).status, 403);
	assert.equal((await send(f, '/', { host: OTHER_HOST, headers: { cookie } })).status, 401);
});

test('follows changed host ports and refuses a recreated container', async (t) => {
	const f = await fixture(t, (_req, res) => res.end('first'));
	const next = createServer((_req, res) => res.end('second'));
	const nextPort = await listen(next);
	t.after(() => close(next));
	const cookie = await login(f);
	assert.equal((await send(f, '/', { headers: { cookie } })).text, 'first');
	f.state.port = nextPort;
	assert.equal((await send(f, '/', { headers: { cookie } })).text, 'second');
	f.state.running = false;
	assert.equal((await send(f, '/', { headers: { cookie } })).status, 409);
	f.state.running = true;
	f.state.id = SHORT + 'c'.repeat(52);
	assert.equal((await send(f, '/', { headers: { cookie } })).status, 404);
});

test('streams SSE and ends it after dashboard logout', async (t) => {
	const f = await fixture(t, (_req, res) => {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write('data: live\n\n');
	});
	const cookie = await login(f);
	await new Promise((done, fail) => {
		const target = { host: '127.0.0.1', port: f.port, path: '/event' };
		const req = httpRequest({ ...target, headers: { host: HOST, cookie } }, (res) => {
			let first = true;
			res.on('data', (chunk) => {
				if (!first) return;
				first = false;
				assert.equal(chunk.toString(), 'data: live\n\n');
				revokeSession(f.parent);
			});
			res.on('close', () => (first ? fail(new Error('No event')) : done()));
			res.on('error', () => {});
		});
		req.on('error', () => done());
		req.setTimeout(2000, () => req.destroy(new Error('Logout did not end the stream')));
		req.end();
	});
	assert.equal((await send(f, '/', { headers: { cookie } })).status, 401);
});

test('authenticates upgrades at the root path and closes them after logout', async (t) => {
	let seen;
	const f = await fixture(t, (_req, res) => res.end());
	f.upstream.on('upgrade', (req, socket) => {
		seen = req;
		socket.on('error', () => {});
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n' +
				'fixture-ready'
		);
	});
	assert.match(await upgrade(f, ''), /^HTTP\/1.1 401/);
	assert.equal(f.state.inspections, 0);
	const cookie = await login(f);
	assert.match(await upgrade(f, cookie, DASHBOARD), /^HTTP\/1.1 403/);
	assert.match(await upgrade(f, cookie), /101 Switching Protocols[\s\S]*fixture-ready/);
	assert.equal(seen.url, '/api/terminal/ws');
	assert.equal(seen.headers.cookie, undefined);
	await new Promise((done, fail) => {
		const socket = connect(f.port, '127.0.0.1');
		let opened = false;
		socket.setTimeout(2000, () => socket.destroy(new Error('Logout did not close the upgrade')));
		socket.on('error', fail);
		socket.on('data', (chunk) => {
			if (!opened && chunk.toString().includes('fixture-ready')) {
				opened = true;
				revokeSession(f.parent);
			}
		});
		socket.once('close', () => (opened ? done() : fail(new Error('Upgrade did not open'))));
		socket.once('connect', () =>
			socket.write(
				`GET /ws HTTP/1.1\r\nHost: ${HOST}\r\nOrigin: ${ORIGIN}\r\nCookie: ${cookie}\r\n` +
					'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
			)
		);
	});
});
