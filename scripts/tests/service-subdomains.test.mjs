/**
 * Disposable regressions for wildcard service subdomains. Build first; no Docker,
 * TLS or Tailscale is used: a plain HTTP fixture stands in for the HTTPS listener.
 * SERVICE_SUBDOMAIN_BUILD_DIR permits testing isolated transpiled server modules.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const base = process.env.SERVICE_SUBDOMAIN_BUILD_DIR
	? pathToFileURL(resolve(process.env.SERVICE_SUBDOMAIN_BUILD_DIR) + '/')
	: new URL('../../build/lib/server/', import.meta.url);
const { createSubdomainGateway } = await import(new URL('serviceSubdomainGateway.js', base));
const { parseSubdomainConfig, parseServiceHost, serviceOrigin } = await import(new URL('serviceSubdomains.js', base));
const { issueServiceLaunch, exchangeServiceLaunch, serviceSessionRoute, SERVICE_SESSION_COOKIE } =
	await import(new URL('serviceOriginAuth.js', base));
const { createSession, revokeSession } = await import(new URL('auth.js', base));

const DASHBOARD = 'https://host.tailnet.ts.net';
const CONFIG = parseSubdomainConfig({ SERVICE_SUBDOMAIN_BASE: 'host.tailnet.ts.net', ORIGIN: DASHBOARD });
const ID = 'a'.repeat(12) + 'b'.repeat(52);
const HOST = `4096-${ID.slice(0, 12)}.host.tailnet.ts.net:8443`;
const ORIGIN = `https://${HOST}`;
const OTHER = `https://3000-${ID.slice(0, 12)}.host.tailnet.ts.net:8443`;
const connections = new WeakMap();

/** Listen on an ephemeral loopback port and track sockets for teardown. */
async function listen(server) {
	const sockets = new Set();
	connections.set(server, sockets);
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
	});
	await new Promise((done, fail) => {
		server.once('error', fail);
		server.listen(0, '127.0.0.1', done);
	});
	return server.address().port;
}

/** Destroy live sockets and wait for listener teardown. */
async function close(server) {
	for (const socket of connections.get(server) ?? []) socket.destroy();
	server.closeAllConnections();
	await new Promise((done) => server.close(done));
}

/** Read the fragment bearer value without sending it in an HTTP URL. */
function ticket(route, parent) {
	return new URL(issueServiceLaunch(route, parent)).hash.slice(1);
}

/** Start an upstream and gateway with fake Docker metadata; never touch a real daemon. */
async function fixture(t, handler) {
	const upstream = createServer(handler);
	const upstreamPort = await listen(upstream);
	const state = { running: true, id: ID, port: upstreamPort, inspections: 0 };
	const parent = createSession();
	const gateway = createSubdomainGateway({
		config: CONFIG,
		inspect: async () => {
			state.inspections++;
			return {
				Id: state.id,
				State: { Running: state.running },
				NetworkSettings: { Ports: { '4096/tcp': [{ HostIp: '127.0.0.1', HostPort: String(state.port) }] } }
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
	return { upstream, port, parent, state, url: `http://127.0.0.1:${port}` };
}

/** Issue HTTP requests with an explicit Host header, as the TLS listener receives them. */
function request(f, path, { host = HOST, ...init } = {}) {
	return fetchVia(f.port, path, host, init);
}

/** Minimal HTTP client: fetch() cannot override Host, so use node:http directly. */
async function fetchVia(port, path, host, { method = 'GET', headers = {}, body } = {}) {
	const http = await import('node:http');
	return new Promise((done, fail) => {
		const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host, ...headers } }, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => done({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
		});
		req.on('error', fail);
		req.end(body);
	});
}

/** Exchange a ticket through the real control route and return the session cookie pair. */
async function login(f, origin = ORIGIN) {
	const res = await request(f, '/__ddash/session', {
		method: 'POST', headers: { origin }, body: ticket({ origin, containerId: ID, containerPort: '4096' }, f.parent)
	});
	assert.equal(res.status, 204);
	assert.match(res.headers['set-cookie'][0], /^__Host-ddash-service-session=.*; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
	return res.headers['set-cookie'][0].split(';')[0];
}

/** Send raw upgrade bytes and resolve with the handshake text. */
function upgrade(port, cookie, origin = ORIGIN, host = HOST) {
	return new Promise((done, fail) => {
		const socket = connect(port, '127.0.0.1');
		let text = '';
		socket.setTimeout(2000, () => socket.destroy(new Error('Upgrade timeout')));
		socket.on('error', fail);
		socket.on('data', (chunk) => {
			text += chunk;
			if (text.includes('fixture-ready') || (!text.startsWith('HTTP/1.1 101') && text.includes('\r\n\r\n'))) {
				socket.destroy();
				done(text);
			}
		});
		socket.once('connect', () => socket.write(
			`GET /api/terminal/ws HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\n` +
			'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
	});
}

test('validates configuration and parses only one-label service hosts', () => {
	assert.equal(parseSubdomainConfig({}), undefined);
	assert.equal(CONFIG.publicPort, 8443);
	for (const env of [
		{ SERVICE_SUBDOMAIN_BASE: 'host.tailnet.ts.net', ORIGIN: 'http://host.tailnet.ts.net' },
		{ SERVICE_SUBDOMAIN_BASE: 'host.tailnet.ts.net', ORIGIN: 'https://other.tailnet.ts.net' },
		{ SERVICE_SUBDOMAIN_BASE: 'host.tailnet.ts.net', ORIGIN: `${DASHBOARD}/` },
		{ SERVICE_SUBDOMAIN_BASE: 'bad_name', ORIGIN: DASHBOARD },
		{ SERVICE_SUBDOMAIN_BASE: 'host.tailnet.ts.net', ORIGIN: DASHBOARD, SERVICE_SUBDOMAIN_PUBLIC_PORT: '70000' }
	]) assert.throws(() => parseSubdomainConfig(env));
	assert.deepEqual(parseServiceHost(CONFIG, HOST), { origin: ORIGIN, shortId: ID.slice(0, 12), containerPort: '4096' });
	assert.equal(parseServiceHost(CONFIG, HOST.toUpperCase()).origin, ORIGIN);
	for (const host of [
		'host.tailnet.ts.net:8443', `4096-${ID.slice(0, 12)}.host.tailnet.ts.net`,
		`4096-${ID.slice(0, 12)}.host.tailnet.ts.net:443`, `x.4096-${ID.slice(0, 12)}.host.tailnet.ts.net:8443`,
		`4096-${ID.slice(0, 11)}.host.tailnet.ts.net:8443`, `70000-${ID.slice(0, 12)}.host.tailnet.ts.net:8443`,
		`4096-${ID.slice(0, 12)}.evil.example:8443`, `4096-${ID.slice(0, 12)}.host.tailnet.ts.net.evil:8443`
	]) assert.equal(parseServiceHost(CONFIG, host), undefined, host);
	const https = parseSubdomainConfig({ SERVICE_SUBDOMAIN_BASE: 'host.tailnet.ts.net', ORIGIN: DASHBOARD, SERVICE_SUBDOMAIN_PUBLIC_PORT: '443' });
	assert.equal(serviceOrigin(https, ID.slice(0, 12), '4096'), `https://4096-${ID.slice(0, 12)}.host.tailnet.ts.net`);
});

test('tickets are origin-bound, single-use and revoked with the dashboard session', () => {
	const parent = createSession();
	const route = { origin: ORIGIN, containerId: ID, containerPort: '4096' };
	const value = ticket(route, parent);
	assert.equal(exchangeServiceLaunch(OTHER, value), undefined);
	const session = exchangeServiceLaunch(ORIGIN, value);
	assert.ok(session);
	assert.equal(exchangeServiceLaunch(ORIGIN, value), undefined);
	const cookie = `${SERVICE_SESSION_COOKIE}=${session}`;
	assert.deepEqual(serviceSessionRoute(ORIGIN, cookie), route);
	assert.equal(serviceSessionRoute(OTHER, cookie), undefined);
	assert.equal(serviceSessionRoute(ORIGIN, `${cookie}; ${cookie}`), undefined);
	revokeSession(parent);
	assert.equal(serviceSessionRoute(ORIGIN, cookie), undefined);
	assert.throws(() => issueServiceLaunch(route, parent));
});

test('rejects unknown hosts and unauthenticated traffic before Docker access', async (t) => {
	const f = await fixture(t, (_req, res) => res.end('unexpected'));
	assert.equal((await request(f, '/', { host: 'evil.example' })).status, 421);
	for (const path of ['/', '/_assets/main.js', '/api/session']) assert.equal((await request(f, path)).status, 401);
	assert.equal(f.state.inspections, 0);
});

test('serves a no-store bridge and rejects foreign-origin or invalid exchanges', async (t) => {
	const f = await fixture(t, (_req, res) => res.end());
	const bridge = await request(f, '/__ddash/launch');
	assert.equal(bridge.status, 200);
	assert.equal(bridge.headers['cache-control'], 'no-store');
	assert.match(bridge.headers['content-security-policy'], /frame-ancestors https:\/\/host\.tailnet\.ts\.net$/);
	const route = { origin: ORIGIN, containerId: ID, containerPort: '4096' };
	assert.equal((await request(f, '/__ddash/session', { method: 'POST', headers: { origin: OTHER }, body: ticket(route, f.parent) })).status, 403);
	assert.equal((await request(f, '/__ddash/session', { method: 'POST', headers: { origin: ORIGIN }, body: 'x'.repeat(43) })).status, 401);
	assert.equal((await request(f, '/__ddash/session', { method: 'POST', headers: { origin: ORIGIN }, body: 'x'.repeat(200) })).status, 400);
	// A ticket for another subdomain cannot be exchanged here.
	const other = ticket({ ...route, origin: OTHER }, f.parent);
	assert.equal((await request(f, '/__ddash/session', { method: 'POST', headers: { origin: ORIGIN }, body: other })).status, 401);
});

test('proxies root paths, uploads and app cookies while stripping gateway credentials', async (t) => {
	let seen;
	const f = await fixture(t, async (req, res) => {
		const parts = [];
		for await (const part of req) parts.push(part);
		seen = { url: req.url, headers: req.headers, body: Buffer.concat(parts).toString() };
		res.writeHead(200, { 'set-cookie': ['sid=app; Domain=tailnet.ts.net; Path=/api; HttpOnly', `${SERVICE_SESSION_COOKIE}=evil; Path=/`] });
		res.end('ok');
	});
	const cookie = await login(f);
	const res = await request(f, '/api/upload?q=a%2Fb', {
		method: 'POST',
		headers: { origin: ORIGIN, authorization: 'Bearer secret', cookie: `${cookie}; devcontainer-dashboard-session=secret; sid=app` },
		body: 'upload-body'
	});
	assert.equal(res.status, 200);
	assert.equal(seen.url, '/api/upload?q=a%2Fb');
	assert.equal(seen.body, 'upload-body');
	assert.equal(seen.headers.cookie, 'sid=app');
	assert.equal(seen.headers.authorization, undefined);
	assert.equal(seen.headers.host, HOST);
	assert.equal(seen.headers.origin, ORIGIN);
	assert.equal(seen.headers['x-forwarded-proto'], 'https');
	// Domain is removed so the cookie stays host-only on this subdomain; reserved names are dropped.
	assert.deepEqual(res.headers['set-cookie'], ['sid=app; Path=/api; HttpOnly']);
});

test('rejects foreign origins, service workers and sessions from another origin', async (t) => {
	const f = await fixture(t, (_req, res) => res.end('ok'));
	const cookie = await login(f);
	assert.equal((await request(f, '/', { headers: { cookie } })).status, 200);
	assert.equal((await request(f, '/', { headers: { cookie, origin: DASHBOARD } })).status, 403);
	assert.equal((await request(f, '/', { headers: { cookie, 'service-worker': 'script' } })).status, 403);
	assert.equal((await request(f, '/', { headers: { cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' } })).status, 403);
	assert.equal((await request(f, '/', { host: OTHER.slice(8), headers: { cookie } })).status, 401);
});

test('follows changed host ports and refuses a recreated container', async (t) => {
	const f = await fixture(t, (_req, res) => res.end('first'));
	const next = createServer((_req, res) => res.end('second'));
	const nextPort = await listen(next);
	t.after(() => close(next));
	const cookie = await login(f);
	assert.equal((await request(f, '/', { headers: { cookie } })).text, 'first');
	f.state.port = nextPort;
	assert.equal((await request(f, '/', { headers: { cookie } })).text, 'second');
	f.state.running = false;
	assert.equal((await request(f, '/', { headers: { cookie } })).status, 409);
	f.state.running = true;
	f.state.id = ID.slice(0, 12) + 'c'.repeat(52);
	assert.equal((await request(f, '/', { headers: { cookie } })).status, 404);
});

test('streams SSE and ends it after dashboard logout', async (t) => {
	const f = await fixture(t, (_req, res) => {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write('data: live\n\n');
	});
	const cookie = await login(f);
	const http = await import('node:http');
	await new Promise((done, fail) => {
		const req = http.request({ host: '127.0.0.1', port: f.port, path: '/api/event', headers: { host: HOST, cookie } }, (res) => {
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
	assert.equal((await request(f, '/', { headers: { cookie } })).status, 401);
});

test('authenticates upgrades at the root path and closes them after logout', async (t) => {
	let seen;
	const f = await fixture(t, (_req, res) => res.end());
	f.upstream.on('upgrade', (req, socket) => {
		seen = req;
		socket.on('error', () => {});
		socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nfixture-ready');
	});
	assert.match(await upgrade(f.port, ''), /^HTTP\/1.1 401/);
	assert.equal(f.state.inspections, 0);
	const cookie = await login(f);
	assert.match(await upgrade(f.port, cookie, DASHBOARD), /^HTTP\/1.1 403/);
	assert.match(await upgrade(f.port, cookie), /101 Switching Protocols[\s\S]*fixture-ready/);
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
		socket.once('connect', () => socket.write(
			`GET /ws HTTP/1.1\r\nHost: ${HOST}\r\nOrigin: ${ORIGIN}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
	});
});
