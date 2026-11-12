/**
 * Dependency-free integration tests for the Tailscale runtime with disposable
 * HTTP, Unix-socket and Docker-inspection fixtures. No real daemon is modified.
 * Run: node --experimental-strip-types --test scripts/tests/tailscale-*.test.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { allocateServePort, createServeConfigClient } from '../../src/lib/server/tailscaleServe.ts';
import {
	startTailscaleServices,
	tailscaleSettings,
	ownsServeEntry,
	removeOwnedServeEntry,
	launchTailscaleService
} from '../../src/lib/server/tailscaleServiceRuntime.ts';

const id = 'a'.repeat(64);
const otherId = 'b'.repeat(64);
const publicHost = 'node.example.ts.net';
const dashboardOrigin = `https://${publicHost}`;
const session = 'devcontainer-dashboard-session=private-session';

/** Bind a disposable HTTP server and register close before removing its files. */
async function listen(t, handler) {
	const server = http.createServer(handler);
	const sockets = new Set();
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(
		() =>
			new Promise((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(resolve);
			})
	);
	return { server, port: server.address().port };
}

/** Reserve an available port, then release it for the runtime's loopback listener. */
async function freePort() {
	const server = net.createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

/** Send HTTP with a browser-facing Host and optional credentials to a local listener. */
function fetchLocal(port, path = '/', headers = {}, method = 'GET', body = '') {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: '127.0.0.1',
				port,
				path,
				method,
				headers: { host: `${publicHost}:8400`, cookie: session, ...headers }
			},
			(res) => {
				let text = '';
				res.on('data', (chunk) => {
					text += chunk;
				});
				res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
			}
		);
		req.on('error', reject);
		req.end(body);
	});
}

/** Run a real LocalAPI HTTP protocol fixture and a mutable live Docker inspection. */
async function fixture(t, overrides = {}) {
	const cleanups = [];
	const parent = t;
	t = { after: (cleanup) => cleanups.push(cleanup) };
	parent.after(async () => {
		for (const cleanup of cleanups.reverse()) await cleanup();
	});
	const directory = await mkdtemp(join(tmpdir(), 'ddash-runtime-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let config = { TCP: { 443: { HTTPS: true } }, Unknown: { preserve: true } };
	let version = 1;
	let authenticated = true;
	let running = true;
	let inspectionError;
	let hostIp = '127.0.0.1';
	let dropWriteResponse = false;
	const received = [];
	const upstream = await listen(t, (req, res) => {
		received.push({ url: req.url, headers: req.headers });
		if (req.url === '/redirect') res.writeHead(302, { Location: '/assets/main.js' }).end();
		else if (req.url === '/escape')
			res.writeHead(302, { Location: `${dashboardOrigin}/api/containers` }).end();
		else if (req.url === '/cookies')
			res
				.writeHead(200, {
					'Set-Cookie': [
						'devcontainer-dashboard-session=attack; Path=/',
						'__Host-other=attack; Secure; Path=/',
						'app=service-cookie; Domain=example.ts.net; Path=/'
					],
					'Clear-Site-Data': '"cookies"',
					'Access-Control-Allow-Origin': '*'
				})
				.end('cookies');
		else if (req.url === '/stream') {
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			res.write('data: connected\n\n');
		} else res.end(req.url);
	});
	upstream.server.on('upgrade', (req, socket, head) => {
		received.push({ url: req.url, headers: req.headers });
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
		);
		if (head.length) socket.write(head);
		socket.on('data', (chunk) => socket.write(chunk));
		socket.on('error', () => socket.destroy());
	});
	const local = http.createServer(async (req, res) => {
		if (req.method === 'GET') {
			res.writeHead(200, { ETag: `"${version}"` }).end(JSON.stringify(config));
		} else {
			let body = '';
			for await (const chunk of req) body += chunk;
			if (req.headers['if-match'] !== `"${version}"`) {
				res.writeHead(412).end();
				return;
			}
			config = JSON.parse(body);
			version++;
			if (dropWriteResponse) {
				res.destroy();
				return;
			}
			res.end('{}');
		}
	});
	const socket = join(directory, 'tailscaled.sock');
	await new Promise((resolve) => local.listen(socket, resolve));
	t.after(() => new Promise((resolve) => local.close(resolve)));
	const client = createServeConfigClient(socket);
	const port = await freePort();
	const settings = {
		socket,
		origin: dashboardOrigin,
		hostname: publicHost,
		first: 8400,
		last: 8405,
		listenPort: port,
		stateFile: join(directory, 'state.json')
	};
	const options = {
		settings,
		client,
		allocate: allocateServePort,
		reconcileMs: 25,
		authenticated: (cookie) =>
			authenticated && cookie?.split(';').some((part) => part.trim() === session),
		inspect: async (requested) => {
			if (inspectionError) throw inspectionError;
			return {
				Id: requested.startsWith('b') ? otherId : id,
				State: { Running: running },
				NetworkSettings: {
					Ports: { '4096/tcp': [{ HostIp: hostIp, HostPort: String(upstream.port) }] }
				}
			};
		},
		ports: { 4096: 'http' },
		...overrides
	};
	let runtime = await startTailscaleServices(options);
	t.after(async () => {
		if (runtime) await runtime.close();
	});
	return {
		directory,
		received,
		options,
		port,
		settings,
		client,
		upstream,
		get config() {
			return config;
		},
		set config(value) {
			config = value;
			version++;
		},
		set running(value) {
			running = value;
		},
		set authenticated(value) {
			authenticated = value;
		},
		set inspectionError(value) {
			inspectionError = value;
		},
		set hostIp(value) {
			hostIp = value;
		},
		set dropWriteResponse(value) {
			dropWriteResponse = value;
		},
		get runtime() {
			return runtime;
		},
		async close() {
			await runtime.close();
			runtime = null;
		},
		async restart() {
			runtime = await startTailscaleServices(options);
		},
		async state() {
			return JSON.parse(await readFile(settings.stateFile, 'utf8'));
		}
	};
}

/** Poll a condition with a bounded deadline instead of fixed long test sleeps. */
async function until(check) {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail('Condition did not become true');
}

test('settings are disabled by default and validate loopback listener/range separation', () => {
	assert.equal(tailscaleSettings({}), null);
	const base = { TAILSCALE_SOCKET: '/run/ts.sock', ORIGIN: dashboardOrigin };
	assert.equal(tailscaleSettings(base).first, 8400);
	for (const values of [
		{ ORIGIN: 'http://node.example.ts.net' },
		{ ORIGIN: 'https://node.example.com' },
		{ ORIGIN: `${dashboardOrigin}/` },
		{ TAILSCALE_SOCKET: 'relative' },
		{ TAILSCALE_SERVE_PORTS: '8400-9999' },
		{ TAILSCALE_GATEWAY_PORT: '8401' },
		{ PORT: '8400' },
		{ ORIGIN: `${dashboardOrigin}:8400` },
		{ TAILSCALE_STATE_FILE: 'relative' }
	])
		assert.throws(() => tailscaleSettings({ ...base, ...values }));
});

test('allocation is idempotent per full identity and port, including concurrent viewer loads', async (t) => {
	const f = await fixture(t);
	const origins = await Promise.all([
		f.runtime.ensure(id.slice(0, 12), '4096'),
		f.runtime.ensure(id, '4096'),
		launchTailscaleService(id, '4096')
	]);
	assert.deepEqual(origins, Array(3).fill(`https://${publicHost}:8400`));
	assert.equal((await f.state()).entries.length, 1);
	assert.deepEqual(f.config.TCP['443'], { HTTPS: true });
	assert.deepEqual(f.config.Unknown, { preserve: true });
});

test('HTTP roots, absolute assets, POST, redirects and credential filtering work through the listener', async (t) => {
	const f = await fixture(t);
	await f.runtime.ensure(id, '4096');
	const origin = `https://${publicHost}:8400`;
	const asset = await fetchLocal(f.port, '/assets/main.js?version=1', {
		cookie: `${session}; app=other-service; ddash-s8400-app=ours`,
		authorization: 'Bearer dashboard-secret',
		'x-forwarded-for': 'fake'
	});
	assert.equal(asset.status, 200);
	assert.equal(asset.text, '/assets/main.js?version=1');
	assert.equal(f.received.at(-1).headers.cookie, 'app=ours');
	assert.equal(f.received.at(-1).headers.authorization, undefined);
	assert.equal(f.received.at(-1).headers['x-forwarded-for'], undefined);
	assert.equal(f.received.at(-1).headers.host, `${publicHost}:8400`);
	assert.equal(
		(await fetchLocal(f.port, '/redirect')).headers.location,
		`${origin}/assets/main.js`
	);
	assert.equal((await fetchLocal(f.port, '/escape')).status, 502);
	assert.equal((await fetchLocal(f.port, '/', { origin }, 'POST', 'body')).status, 200);
	assert.equal((await fetchLocal(f.port, '/', { origin: dashboardOrigin }, 'POST')).status, 403);
});

test('unauthenticated, unknown-host and non-loopback targets never reach an upstream', async (t) => {
	const f = await fixture(t);
	await f.runtime.ensure(id, '4096');
	for (const headers of [
		{ cookie: '' },
		{ host: `${publicHost}:8401` },
		{ origin: 'https://evil.example' },
		{ 'service-worker': 'script' },
		{ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' }
	])
		assert.equal((await fetchLocal(f.port, '/', headers)).status, 403);
	f.hostIp = '0.0.0.0';
	assert.equal((await fetchLocal(f.port)).status, 403);
	await assert.rejects(f.runtime.ensure(otherId, '4096'), /loopback/);
	assert.equal(f.received.length, 0);
});

test('response cookies are port-namespaced and cannot replace dashboard credentials', async (t) => {
	const f = await fixture(t);
	await f.runtime.ensure(id, '4096');
	const result = await fetchLocal(f.port, '/cookies');
	assert.equal(result.headers['set-cookie'].length, 1);
	assert.match(result.headers['set-cookie'][0], /^ddash-s8400-app=service-cookie;/);
	assert.match(result.headers['set-cookie'][0], /HttpOnly/);
	assert.doesNotMatch(result.headers['set-cookie'][0], /Domain=/i);
	assert.equal(result.headers['clear-site-data'], undefined);
	assert.equal(result.headers['access-control-allow-origin'], undefined);
});

test('stop/removal cleanup preserves unrelated Serve entries', async (t) => {
	const f = await fixture(t);
	await f.runtime.ensure(id, '4096');
	f.running = false;
	await until(async () => (await f.state()).entries.length === 0);
	assert.equal(f.config.TCP['8400'], undefined);
	assert.deepEqual(f.config.TCP['443'], { HTTPS: true });
	assert.deepEqual(f.config.Unknown, { preserve: true });
	f.running = true;
	await f.runtime.ensure(id, '4096');
	f.inspectionError = { statusCode: 404 };
	await until(async () => (await f.state()).entries.length === 0);
	assert.equal(f.config.TCP['8400'], undefined);
});

test('operator-edited listeners are never removed on shutdown', async (t) => {
	const f = await fixture(t);
	await f.runtime.ensure(id, '4096');
	f.config = {
		...f.config,
		Web: { ...f.config.Web, [`${publicHost}:8400`]: { Handlers: { '/': { Text: 'operator' } } } }
	};
	await f.close();
	assert.equal(f.config.Web[`${publicHost}:8400`].Handlers['/'].Text, 'operator');
	assert.deepEqual(f.config.TCP['8400'], { HTTPS: true });
});

test('ownership cleanup refuses additional handlers, hosts, Funnel or modified TCP', () => {
	const entry = {
		id,
		port: '4096',
		hostPort: 4000,
		servePort: 8400,
		hostname: publicHost,
		proxy: 'http://127.0.0.1:3003'
	};
	const config = {
		TCP: { 8400: { HTTPS: true } },
		Web: { [`${publicHost}:8400`]: { Handlers: { '/': { Proxy: entry.proxy } } } },
		Unknown: true
	};
	assert.equal(ownsServeEntry(config, entry), true);
	for (const change of [
		{ TCP: { 8400: { TCPForward: '127.0.0.1:99' } } },
		{ Web: { ...config.Web, 'other.ts.net:8400': {} } },
		{ AllowFunnel: { [`${publicHost}:8400`]: false } },
		{ Foreground: { session: { TCP: { 8400: { HTTPS: true } } } } }
	]) {
		const current = { ...structuredClone(config), ...change };
		const before = structuredClone(current);
		assert.equal(removeOwnedServeEntry(current, entry), false);
		assert.deepEqual(current, before);
	}
	assert.equal(removeOwnedServeEntry(config, entry), true);
	assert.equal(config.Unknown, true);
});

test('restart clears crash-left owned handlers before serving and preserves foreign ones', async (t) => {
	const f = await fixture(t);
	await f.runtime.ensure(id, '4096');
	const journal = await f.state();
	const oldConfig = structuredClone(f.config);
	await f.close();
	// Model a killed process: its persisted journal and daemon config both survived.
	await writeFile(f.settings.stateFile, JSON.stringify(journal));
	f.config = oldConfig;
	await f.restart();
	assert.equal(f.config.TCP['8400'], undefined);
	assert.deepEqual(f.config.TCP['443'], { HTTPS: true });
	assert.equal((await f.state()).entries.length, 0);
});

test('a stale same-container process lock is recoverable, an active lock is not', async (t) => {
	const f = await fixture(t);
	await assert.rejects(startTailscaleServices(f.options), /running process/);
	await f.close();
	await mkdir(`${f.settings.stateFile}.lock`);
	await writeFile(
		join(`${f.settings.stateFile}.lock`, 'owner'),
		JSON.stringify({
			pid: process.pid,
			host: hostname(),
			start: 'old-start-ticks'
		})
	);
	await f.restart();
	assert.equal(await f.runtime.ensure(id, '4096'), `https://${publicHost}:8400`);
});

test('transient Docker failures do not remove owned configuration', async (t) => {
	const f = await fixture(t);
	await f.runtime.ensure(id, '4096');
	f.inspectionError = new Error('Docker unavailable');
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal((await f.state()).entries.length, 1);
	assert.ok(f.config.TCP['8400']);
});

test('a lost daemon write response retains an intent that startup cleanup can identify', async (t) => {
	const f = await fixture(t);
	f.dropWriteResponse = true;
	await assert.rejects(f.runtime.ensure(id, '4096'));
	assert.equal((await f.state()).entries.length, 1);
	assert.ok(f.config.TCP['8400']);
	const state = await f.state();
	const config = structuredClone(f.config);
	f.dropWriteResponse = false;
	await f.close();
	await writeFile(f.settings.stateFile, JSON.stringify(state));
	f.config = config;
	await f.restart();
	assert.equal(f.config.TCP['8400'], undefined);
});

test('allocation does not reuse an operator-occupied port and fails on an exhausted range', async (t) => {
	const f = await fixture(t);
	const occupied = { HTTPS: true };
	f.config = { ...f.config, TCP: { ...f.config.TCP, 8400: occupied } };
	assert.equal(await f.runtime.ensure(id, '4096'), `https://${publicHost}:8401`);
	for (let port = 8402; port <= 8405; port++) f.config.TCP[port] = occupied;
	await assert.rejects(f.runtime.ensure(otherId, '4096'), /No free/);
	assert.deepEqual(f.config.TCP['8400'], occupied);
});

test('disabling the feature leaves the viewer runtime unavailable', () => {
	assert.throws(() => launchTailscaleService(id, '4096'), /unavailable/);
});

test('WebSocket upgrades preserve root paths and strip dashboard credentials', async (t) => {
	const f = await fixture(t);
	await f.runtime.ensure(id, '4096');
	const origin = `https://${publicHost}:8400`;
	const result = await new Promise((resolve, reject) => {
		const req = http.request({
			host: '127.0.0.1',
			port: f.port,
			path: '/ws?root=yes',
			headers: {
				host: `${publicHost}:8400`,
				cookie: session,
				origin,
				connection: 'Upgrade',
				upgrade: 'websocket'
			}
		});
		req.on('error', reject);
		req.on('upgrade', (_res, socket) => {
			socket.once('data', (chunk) => {
				resolve(chunk.toString());
				socket.destroy();
			});
			socket.write('echo-payload');
		});
		req.end();
	});
	assert.equal(result, 'echo-payload');
	assert.equal(f.received.at(-1).url, '/ws?root=yes');
	assert.equal(f.received.at(-1).headers.cookie, undefined);
});

test('logout closes an existing stream without waiting for another request', async (t) => {
	const f = await fixture(t);
	await f.runtime.ensure(id, '4096');
	await new Promise((resolve, reject) => {
		const req = http.get(
			{
				host: '127.0.0.1',
				port: f.port,
				path: '/stream',
				headers: { host: `${publicHost}:8400`, cookie: session }
			},
			(res) => {
				res.once('data', () => {
					f.authenticated = false;
				});
				res.once('close', resolve);
			}
		);
		req.on('error', reject);
	});
	assert.equal((await fetchLocal(f.port)).status, 403);
});

test('launcher passes explicit socket/range flags, uses host networking and disables publication', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'ddash-launch-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const docker = join(directory, 'docker');
	await writeFile(
		docker,
		`#!/bin/sh
if [ "$1" = info ]; then
  if [ "$#" -gt 1 ]; then echo linux; fi
  exit 0
fi
if [ "$1" = run ]; then printf '<%s>\\n' "$@"; fi
`,
		{ mode: 0o755 }
	);
	const base = [
		'scripts/run-dashboard.sh',
		'--non-interactive',
		'--no-create-workspace',
		'--password',
		'not-logged',
		'--host-user',
		'operator',
		'--host-uid',
		'2345',
		'--host-gid',
		'3456',
		'--host-home',
		'/home/operator'
	];
	const run = (extra) =>
		spawnSync('bash', [...base, ...extra], {
			cwd: new URL('../../', import.meta.url),
			encoding: 'utf8',
			env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, SSH_AUTH_SOCK: '' }
		});
	const result = run(['--tailscale-socket', '/run/tailscale.sock', '--origin', dashboardOrigin]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /<--network>\n<host>/);
	assert.match(result.stdout, /TAILSCALE_SERVE_PORTS=8400-8499/);
	assert.match(result.stdout, /SERVICE_PROXY_ENABLED=1/);
	assert.match(result.stdout, /target=\/var\/run\/tailscale\/tailscaled.sock/);
	assert.doesNotMatch(result.stdout, /--publish|not-logged/);
	for (const extra of [
		['--tailscale-ports', '8400-8410'],
		['--tailscale-socket', '/run/ts.sock'],
		['--tailscale-socket', '/run/ts.sock', '--origin', dashboardOrigin, '--gateway'],
		[
			'--tailscale-socket',
			'/run/ts.sock',
			'--origin',
			dashboardOrigin,
			'--tailscale-gateway-port',
			'8400'
		]
	])
		assert.notEqual(run(extra).status, 0);
});

/** Load the actual TypeScript route with only its external imports replaced by controlled fixtures. */
async function routeModule(t, relativePath, replacements) {
	const directory = await mkdtemp(join(tmpdir(), 'ddash-route-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const sourcePath = fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
	let source = await readFile(sourcePath, 'utf8');
	for (const [existing, replacement] of replacements) {
		assert.ok(source.includes(existing), `Route import changed: ${existing}`);
		source = source.replace(existing, replacement);
	}
	const target = join(directory, 'route.ts');
	await writeFile(target, source);
	return import(pathToFileURL(target).href);
}

test('the viewer allocates a root HTTPS iframe and does not fall back on failure', async (t) => {
	const originalSocket = process.env.TAILSCALE_SOCKET;
	process.env.TAILSCALE_SOCKET = '/test/socket';
	t.after(() => {
		if (originalSocket === undefined) delete process.env.TAILSCALE_SOCKET;
		else process.env.TAILSCALE_SOCKET = originalSocket;
		delete globalThis.__testTailscaleLaunch;
	});
	const calls = [];
	globalThis.__testTailscaleLaunch = async (...args) => {
		calls.push(args);
		return `https://${publicHost}:8400`;
	};
	const module = await routeModule(t, 'src/routes/service/+page.server.ts', [
		[
			"import { describeServiceTarget, isServiceProxyEnabled } from '$lib/server/serviceGatewayRuntime.js';",
			"const describeServiceTarget = async () => { throw Error('Unexpected path gateway fallback'); }; const isServiceProxyEnabled = () => false;"
		],
		[
			"import { launchTailscaleService } from '$lib/server/tailscaleServiceRuntime.js';",
			'const launchTailscaleService = (...args: string[]) => (globalThis as any).__testTailscaleLaunch(...args);'
		],
		[
			"import { embedProfile, serviceDirectUrl, serviceProxyPath } from '$lib/serviceTargets.js';",
			"const embedProfile = () => ({mode:'direct'}); const serviceDirectUrl = () => ''; const serviceProxyPath = () => '';"
		]
	]);
	const url = new URL(`/service?cid=${id}&port=4096`, dashboardOrigin);
	const result = await module.load({ url });
	assert.equal(result.viewer.kind, 'proxy');
	assert.equal(result.viewer.target, `https://${publicHost}:8400/`);
	assert.deepEqual(calls, [[id, '4096']]);
	globalThis.__testTailscaleLaunch = async () => {
		throw new Error('Allocation failed');
	};
	const failed = await module.load({ url });
	assert.equal(failed.viewer.kind, 'unavailable');
	assert.equal(failed.viewer.target, undefined);
	const legacy = await module.load({
		url: new URL('/service?url=http://evil.example', dashboardOrigin)
	});
	assert.equal(legacy.viewer.kind, 'unavailable');
});

test('dashboard policy refuses service-origin writes and reads while allowing login and same-origin API use', async (t) => {
	const oldSocket = process.env.TAILSCALE_SOCKET;
	const oldOrigin = process.env.ORIGIN;
	process.env.TAILSCALE_SOCKET = '/test/socket';
	process.env.ORIGIN = dashboardOrigin;
	t.after(() => {
		if (oldSocket === undefined) delete process.env.TAILSCALE_SOCKET;
		else process.env.TAILSCALE_SOCKET = oldSocket;
		if (oldOrigin === undefined) delete process.env.ORIGIN;
		else process.env.ORIGIN = oldOrigin;
	});
	const module = await routeModule(t, 'src/hooks.server.ts', [
		[
			"import { AUTH_COOKIE_NAME, assertAuthConfigured, isSessionValid } from '$lib/server/auth';",
			"const AUTH_COOKIE_NAME = 'session'; const assertAuthConfigured = () => {}; const isSessionValid = (token: string) => token === 'valid';"
		]
	]);
	const invoke = (method, headers, path = '/api/containers', valid = true) =>
		module.handle({
			event: {
				url: new URL(path, dashboardOrigin),
				request: new Request(new URL(path, dashboardOrigin), { method, headers }),
				cookies: { get: () => (valid ? 'valid' : undefined) }
			},
			resolve: () => new Response('allowed', { status: 200 })
		});
	assert.equal((await invoke('POST', { origin: `https://${publicHost}:8400` })).status, 403);
	assert.equal((await invoke('GET', { origin: `https://${publicHost}:8400` })).status, 403);
	assert.equal(
		(await invoke('GET', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' })).status,
		403
	);
	assert.equal((await invoke('POST', {})).status, 403);
	assert.equal((await invoke('GET', {})).status, 200);
	assert.equal((await invoke('POST', { origin: dashboardOrigin })).status, 200);
	assert.equal((await invoke('POST', { origin: dashboardOrigin }, '/login', false)).status, 200);
	assert.equal((await invoke('GET', {}, '/api/containers', false)).status, 401);
});
