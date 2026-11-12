/**
 * Opt-in, same-node Tailscale HTTPS service origins.
 * The host-network launcher keeps both HTTP listeners on host loopback.
 * Durable intents identify owned Serve entries; all proxy requests require a
 * dashboard session and revalidate the full Docker identity and loopback binding.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { hostname } from 'node:os';
import type { Duplex } from 'node:stream';
import type { ServeConfig } from './tailscaleServe.js';

type Inspection = {
	Id: string;
	State: { Running: boolean };
	NetworkSettings: { Ports?: Record<string, { HostIp: string; HostPort: string }[] | null> };
};
type Entry = {
	id: string;
	port: string;
	hostPort: number;
	servePort: number;
	hostname: string;
	proxy: string;
};
type Journal = { version: 1; owner: string; entries: Entry[] };
type Client = {
	get: () => Promise<{ config: ServeConfig; etag: string }>;
	update: (merge: (config: ServeConfig) => Promise<ServeConfig | null>) => Promise<ServeConfig>;
};
export type TailscaleSettings = {
	socket: string;
	origin: string;
	hostname: string;
	first: number;
	last: number;
	listenPort: number;
	stateFile: string;
};
type Options = {
	settings: TailscaleSettings;
	client: Client;
	allocate: (config: ServeConfig, first: number, last: number) => number;
	inspect: (id: string) => Promise<Inspection>;
	authenticated: (cookie: string | undefined) => boolean;
	ports: Record<string, 'http' | 'https' | 'off'>;
	/** Only tests override the cadence; production reconciles every five seconds. */
	reconcileMs?: number;
};
type Runtime = {
	ensure: (id: string, port: string) => Promise<string>;
	close: () => Promise<void>;
};
const shared = globalThis as typeof globalThis & { __ddashTailscaleRuntime?: Runtime };
const SESSION_COOKIE = 'devcontainer-dashboard-session';

/** Parse strict startup settings only when the operator supplied an explicit socket. */
export function tailscaleSettings(env: NodeJS.ProcessEnv): TailscaleSettings | null {
	if (!env.TAILSCALE_SOCKET) return null;
	if (!isAbsolute(env.TAILSCALE_SOCKET)) throw new Error('TAILSCALE_SOCKET must be absolute');
	const origin = new URL(env.ORIGIN ?? '');
	if (
		origin.protocol !== 'https:' ||
		origin.origin !== env.ORIGIN ||
		!origin.hostname.endsWith('.ts.net') ||
		origin.username ||
		origin.password
	) {
		throw new Error('Tailscale origins require an exact https://node.tailnet.ts.net ORIGIN');
	}
	const range = /^([1-9]\d{0,4})-([1-9]\d{0,4})$/.exec(env.TAILSCALE_SERVE_PORTS ?? '8400-8499');
	const listen = env.TAILSCALE_GATEWAY_PORT ?? '3003';
	if (!range || !/^[1-9]\d{0,4}$/.test(listen)) throw new Error('Invalid Tailscale ports');
	const first = Number(range[1]);
	const last = Number(range[2]);
	const listenPort = Number(listen);
	if (first > last || last > 65535 || listenPort > 65535 || last - first > 255) {
		throw new Error('Invalid Tailscale port range (maximum 256 ports)');
	}
	const mainPort = Number(env.PORT ?? '3000');
	const dashboardPort = Number(origin.port || '443');
	if (
		!Number.isInteger(mainPort) ||
		mainPort < 1 ||
		mainPort > 65535 ||
		mainPort === listenPort ||
		[
			first <= mainPort && mainPort <= last,
			first <= listenPort && listenPort <= last,
			first <= dashboardPort && dashboardPort <= last
		].some(Boolean)
	) {
		throw new Error('Tailscale port ranges must not overlap dashboard or gateway listeners');
	}
	const stateFile = env.TAILSCALE_STATE_FILE ?? '/data/tailscale-serve.json';
	if (!isAbsolute(stateFile)) throw new Error('TAILSCALE_STATE_FILE must be absolute');
	return {
		socket: env.TAILSCALE_SOCKET,
		origin: origin.origin,
		hostname: origin.hostname,
		first,
		last,
		listenPort,
		stateFile
	};
}

/** The viewer uses the custom server's singleton, including when SvelteKit bundles this module. */
export function launchTailscaleService(id: string, port: string): Promise<string> {
	if (!shared.__ddashTailscaleRuntime) {
		throw new Error('Tailscale service runtime unavailable. Use the production launcher.');
	}
	return shared.__ddashTailscaleRuntime.ensure(id, port);
}

/** Expected owned entries use only fields supported by tailscaled, never an invented tag. */
function expected(entry: Entry) {
	return {
		tcp: { HTTPS: true },
		web: { Handlers: { '/': { Proxy: entry.proxy } } },
		key: `${entry.hostname}:${entry.servePort}`
	};
}

/** Compare the complete listener; operator edits transfer ownership away from the dashboard. */
export function ownsServeEntry(config: ServeConfig, entry: Entry): boolean {
	const wanted = expected(entry);
	if (
		!isDeepStrictEqual(config.TCP?.[String(entry.servePort)], wanted.tcp) ||
		!isDeepStrictEqual(config.Web?.[wanted.key], wanted.web) ||
		Object.keys(config.Web ?? {}).some(
			(key) => key !== wanted.key && key.endsWith(`:${entry.servePort}`)
		) ||
		Object.keys(config.AllowFunnel ?? {}).some((key) => key.endsWith(`:${entry.servePort}`))
	)
		return false;
	// A foreground entry may shadow this listener. Do not change a shared TCP entry.
	return !Object.values(config.Foreground ?? {}).some((scope) =>
		Object.prototype.hasOwnProperty.call(scope?.TCP ?? {}, String(entry.servePort))
	);
}

/** Remove only an exact owned pair, preserving every unrelated and unknown configuration field. */
export function removeOwnedServeEntry(config: ServeConfig, entry: Entry): boolean {
	if (!ownsServeEntry(config, entry)) return false;
	delete config.TCP?.[String(entry.servePort)];
	delete config.Web?.[expected(entry).key];
	return true;
}

/** Return one running service's loopback-only published port, never a client-selected address. */
function binding(info: Inspection, id: string, port: string): number {
	const entries = info.NetworkSettings.Ports?.[`${port}/tcp`];
	if (
		!/^[a-f0-9]{64}$/.test(info.Id) ||
		!info.Id.startsWith(id) ||
		!info.State.Running ||
		!entries?.length ||
		entries.some((entry) => !['127.0.0.1', '::1'].includes(entry.HostIp)) ||
		!entries.some((entry) => entry.HostIp === '127.0.0.1') ||
		new Set(entries.map((entry) => entry.HostPort)).size !== 1
	)
		throw new Error('Service must be running and published on IPv4 host loopback only');
	const value = entries[0].HostPort;
	if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) {
		throw new Error('Invalid service binding');
	}
	return Number(value);
}

/** Read only our versioned journal; corrupt or unsafe state must not trigger cleanup. */
function parseJournal(value: unknown): Journal {
	const state = value as Journal;
	if (
		!state ||
		state.version !== 1 ||
		typeof state.owner !== 'string' ||
		!Array.isArray(state.entries) ||
		state.entries.length > 256 ||
		state.entries.some(
			(entry) =>
				!/^[a-f0-9]{64}$/.test(entry.id) ||
				!/^[1-9]\d{0,4}$/.test(entry.port) ||
				Number(entry.port) > 65535 ||
				!Number.isInteger(entry.hostPort) ||
				entry.hostPort < 1 ||
				entry.hostPort > 65535 ||
				!Number.isInteger(entry.servePort) ||
				entry.servePort < 1 ||
				entry.servePort > 65535 ||
				!/^[a-z0-9.-]+\.ts\.net$/.test(entry.hostname) ||
				!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(entry.proxy)
		) ||
		new Set(state.entries.map((entry) => entry.servePort)).size !== state.entries.length
	)
		throw new Error('Invalid Tailscale ownership journal; manual inspection required');
	return state;
}

/** Non-cacheable errors must not disclose Docker addresses, credentials, or daemon output. */
function reply(response: ServerResponse, status: number, message: string) {
	response.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
	response.end(message);
}

/** Remove hop headers and untrusted proxy metadata before rebuilding controlled values. */
function clean(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
	const blocked = new Set([
		'connection',
		'keep-alive',
		'proxy-authenticate',
		'proxy-authorization',
		'te',
		'trailer',
		'transfer-encoding',
		'upgrade',
		'host',
		'forwarded',
		...(headers.connection ?? '').split(',').map((name) => name.trim().toLowerCase())
	]);
	return Object.fromEntries(
		Object.entries(headers).filter(
			([name]) =>
				!blocked.has(name) && !name.startsWith('x-forwarded-') && !name.startsWith('tailscale-')
		)
	);
}

/** Start the authenticated origin listener and own at most one serialized journal/config update. */
export async function startTailscaleServices(options: Options): Promise<Runtime> {
	const { settings, client } = options;
	// OpenChamber's standard port is enabled only for dedicated origins, not the
	// old same-origin path proxy. An explicit operator 'off' still wins.
	const ports: Record<string, 'http' | 'https' | 'off'> = { '3000': 'http', ...options.ports };
	const lock = `${settings.stateFile}.lock`;
	await mkdir(dirname(settings.stateFile), { recursive: true });
	/** Linux process start ticks distinguish a reused PID after a container restart. */
	async function processStart(pid: number) {
		const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
		return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
	}
	try {
		await mkdir(lock);
	} catch (error) {
		if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
			throw error;
		const owner = JSON.parse(await readFile(join(lock, 'owner'), 'utf8')) as {
			pid: number;
			host: string;
			start: string;
		};
		if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid < 1) {
			throw new Error(
				'Tailscale journal locked by another container; inspect it before removing the lock'
			);
		}
		let active = false;
		try {
			active = (await processStart(owner.pid)) === owner.start;
		} catch (lookupError) {
			if (
				!(
					lookupError &&
					typeof lookupError === 'object' &&
					'code' in lookupError &&
					lookupError.code === 'ENOENT'
				)
			)
				throw lookupError;
		}
		if (active) throw new Error('Tailscale state is locked by a running process');
		await rm(lock, { recursive: true });
		await mkdir(lock);
	}
	const lockOwner = await open(join(lock, 'owner'), 'wx', 0o600);
	try {
		await lockOwner.writeFile(
			JSON.stringify({
				pid: process.pid,
				host: hostname(),
				start: await processStart(process.pid)
			})
		);
		await lockOwner.sync();
	} finally {
		await lockOwner.close();
	}
	let journal: Journal = { version: 1, owner: randomUUID(), entries: [] };
	let queue: Promise<unknown> = Promise.resolve();
	let closing = false;
	const responses = new Set<ServerResponse>();
	const upgrades = new Set<Duplex>();

	/** Serialize allocations, retry callbacks and cleanup so journal intents cannot race. */
	function serial<T>(work: () => Promise<T>): Promise<T> {
		const result = queue.then(work);
		queue = result.catch(() => {});
		return result;
	}

	/** Bound Docker lookups without treating a transient timeout as container removal. */
	async function lookup(id: string): Promise<Inspection> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				options.inspect(id),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error('Docker lookup timed out')), 10_000);
				})
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Flush an intent before a daemon write; rename plus directory fsync is crash-safe on Linux. */
	async function persist() {
		const temporary = `${settings.stateFile}.tmp`;
		const file = await open(temporary, 'w', 0o600);
		try {
			await file.writeFile(JSON.stringify(journal));
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, settings.stateFile);
		const directory = await open(dirname(settings.stateFile), 'r');
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}

	/** Forget an intent only after a conditional cleanup succeeds or the operator owns the entry. */
	async function retire(entry: Entry) {
		await client.update(async (config) => (removeOwnedServeEntry(config, entry) ? config : null));
		journal.entries = journal.entries.filter((current) => current !== entry);
		await persist();
	}

	/** Validate allowed service identities before any allocation or Docker host access. */
	async function inspect(id: string, port: string) {
		if (
			!/^[a-f0-9]{12,64}$/.test(id) ||
			!/^[1-9]\d{0,4}$/.test(port) ||
			Number(port) > 65535 ||
			!['http', 'https'].includes(ports[port])
		) {
			throw new Error('Invalid or disabled web service identity');
		}
		const info = await lookup(id);
		return { id: info.Id, hostPort: binding(info, id, port) };
	}

	/** Return a stable origin per full container identity and port; journal before each attempted write. */
	async function ensure(id: string, port: string): Promise<string> {
		return serial(async () => {
			if (closing) throw new Error('Tailscale runtime is stopping');
			const service = await inspect(id, port);
			const existing = journal.entries.find(
				(entry) => entry.id === service.id && entry.port === port
			);
			if (existing) {
				const snapshot = await client.get();
				if (existing.hostPort === service.hostPort && ownsServeEntry(snapshot.config, existing)) {
					return `https://${existing.hostname}:${existing.servePort}`;
				}
				await retire(existing);
			}
			let selected: Entry | undefined;
			await client.update(async (config) => {
				// A previous retry's intent did not commit (HTTP 412). Replace that intent.
				if (selected) journal.entries = journal.entries.filter((entry) => entry !== selected);
				const servePort = options.allocate(config, settings.first, settings.last);
				selected = {
					...service,
					port,
					servePort,
					hostname: settings.hostname,
					proxy: `http://127.0.0.1:${settings.listenPort}`
				};
				journal.entries.push(selected);
				await persist();
				const wanted = expected(selected);
				config.TCP = { ...config.TCP, [servePort]: wanted.tcp };
				config.Web = { ...config.Web, [wanted.key]: wanted.web };
				return config;
			});
			if (!selected) throw new Error('No Tailscale allocation was created');
			return `https://${selected.hostname}:${selected.servePort}`;
		});
	}

	/** Resolve an exact allocated Host, authenticate, and revalidate live Docker before proxying. */
	async function target(request: IncomingMessage, upgrade: boolean) {
		if (closing || !options.authenticated(request.headers.cookie)) throw new Error('Unauthorized');
		const entry = journal.entries.find(
			(item) => request.headers.host === `${item.hostname}:${item.servePort}`
		);
		if (!entry) throw new Error('Unknown service origin');
		const origin = `https://${entry.hostname}:${entry.servePort}`;
		if (
			(request.headers.origin && request.headers.origin !== origin) ||
			((upgrade || !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '')) &&
				request.headers.origin !== origin) ||
			request.headers['service-worker'] ||
			(!request.headers.origin &&
				request.headers['sec-fetch-site'] &&
				!['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])) &&
				request.headers['sec-fetch-mode'] !== 'navigate')
		)
			throw new Error('Service origin required');
		if (!request.url?.startsWith('/') || request.url.startsWith('//'))
			throw new Error('Invalid path');
		const live = await inspect(entry.id, entry.port);
		if (live.hostPort !== entry.hostPort) throw new Error('Service binding changed');
		return { entry, origin };
	}

	/** Proxy service cookies under a port-specific name, never forward the dashboard session. */
	function requestHeaders(request: IncomingMessage, entry: Entry, origin: string) {
		const headers = clean(request.headers);
		delete headers.authorization;
		// Dashboard authentication uses only its session cookie. A service's
		// explicit same-origin Basic credentials (OpenCode) belong upstream.
		// Do not forward ambient credentials from a navigation or another origin.
		if (
			/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(request.headers.authorization ?? '') &&
			(request.headers.origin === origin ||
				(!request.headers.origin && request.headers['sec-fetch-site'] === 'same-origin'))
		) {
			headers.authorization = request.headers.authorization;
		}
		delete headers.referer;
		delete headers.cookie;
		const prefix = `ddash-s${entry.servePort}-`;
		const cookies = (request.headers.cookie ?? '').split(';').flatMap((part) => {
			const trimmed = part.trim();
			const at = trimmed.indexOf('=');
			if (at < 0 || !trimmed.startsWith(prefix)) return [];
			const name = trimmed.slice(prefix.length, at);
			if (name === SESSION_COOKIE || name.startsWith('__Host-')) return [];
			return [`${name}=${trimmed.slice(at + 1)}`];
		});
		if (cookies.length) headers.cookie = cookies.join('; ');
		headers.host = new URL(origin).host;
		headers['x-forwarded-host'] = headers.host;
		headers['x-forwarded-proto'] = 'https';
		return headers;
	}

	/** Keep frame protections; constrain redirects and prevent cookie or site-state escalation. */
	function responseHeaders(incoming: IncomingMessage, entry: Entry, origin: string) {
		const headers = clean(incoming.headers);
		for (const name of Object.keys(headers)) {
			if (name.startsWith('access-control-')) delete headers[name];
		}
		for (const name of ['alt-svc', 'clear-site-data', 'service-worker-allowed', 'set-cookie']) {
			delete headers[name];
		}
		headers['cache-control'] = 'no-store';
		headers['referrer-policy'] = 'no-referrer';
		const cookies = incoming.headers['set-cookie']?.flatMap((cookie) => {
			const [pair, ...attributes] = cookie.split(';');
			const at = pair.indexOf('=');
			const name = pair.slice(0, at).trim();
			if (at < 1 || name === SESSION_COOKIE || name.startsWith('__Host-')) return [];
			return [
				[
					`ddash-s${entry.servePort}-${pair.trim()}`,
					...attributes.filter((part) => !/^\s*(domain|path|secure|httponly)\s*(=|$)/i.test(part)),
					'Path=/',
					'Secure',
					'HttpOnly'
				].join('; ')
			];
		});
		if (cookies?.length) headers['set-cookie'] = cookies;
		if (incoming.headers.location) {
			const redirect = new URL(incoming.headers.location, origin);
			if (
				![origin, `${ports[entry.port]}://127.0.0.1:${entry.hostPort}`].includes(
					redirect.origin
				)
			) {
				throw new Error('Cross-origin service redirect refused');
			}
			headers.location = `${origin}${redirect.pathname}${redirect.search}${redirect.hash}`;
		}
		return headers;
	}

	/** Open the validated host-loopback upstream with the service's configured protocol. */
	function upstream(request: IncomingMessage, entry: Entry, origin: string) {
		return (ports[entry.port] === 'https' ? https : http).request({
			hostname: '127.0.0.1',
			port: entry.hostPort,
			method: request.method,
			path: request.url,
			headers: requestHeaders(request, entry, origin)
		});
	}

	/** Revoke long-lived connections after logout or stop/removal, not just on the next request. */
	function lease(cookie: string | undefined, entry: Entry, close: () => void) {
		const timer = setInterval(() => {
			if (closing || !options.authenticated(cookie) || !journal.entries.includes(entry)) close();
		}, 1000);
		timer.unref();
		return timer;
	}

	/** Stream HTTP and SSE with bounded initial response time and backpressure. */
	async function handle(request: IncomingMessage, response: ServerResponse) {
		try {
			const { entry, origin } = await target(request, false);
			const peer = upstream(request, entry, origin);
			const timer = setTimeout(() => peer.destroy(new Error('Upstream timeout')), 10_000);
			const authTimer = lease(request.headers.cookie, entry, () => response.destroy());
			responses.add(response);
			response.once('close', () => {
				responses.delete(response);
				clearTimeout(timer);
				clearInterval(authTimer);
				peer.destroy();
			});
			request.once('aborted', () => peer.destroy());
			peer.once('error', () => {
				clearTimeout(timer);
				if (response.destroyed) return;
				if (response.headersSent) response.destroy();
				else reply(response, 502, 'Service unreachable');
			});
			peer.once('response', (incoming) => {
				clearTimeout(timer);
				try {
					response.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming, entry, origin));
					incoming.once('error', () => response.destroy());
					incoming.once('aborted', () => response.destroy());
					incoming.pipe(response);
				} catch {
					incoming.destroy();
					reply(response, 502, 'Service redirect refused');
				}
			});
			request.pipe(peer);
		} catch {
			if (!response.destroyed)
				reply(response, 403, 'Reopen this running service from the dashboard');
		}
	}

	/** Tunnel authenticated WebSockets at the unchanged application root. */
	async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
		socket.on('error', () => socket.destroy());
		try {
			const { entry, origin } = await target(request, true);
			if (socket.destroyed || request.headers.upgrade?.toLowerCase() !== 'websocket') {
				socket.destroy();
				return;
			}
			const peer = upstream(request, entry, origin);
			peer.setHeader('connection', 'Upgrade');
			peer.setHeader('upgrade', 'websocket');
			const timer = setTimeout(() => peer.destroy(new Error('Upgrade timeout')), 10_000);
			const authTimer = lease(request.headers.cookie, entry, () => socket.destroy());
			upgrades.add(socket);
			socket.once('close', () => {
				upgrades.delete(socket);
				clearTimeout(timer);
				clearInterval(authTimer);
				peer.destroy();
			});
			peer.once('error', () => socket.destroy());
			peer.once('response', (incoming) => {
				incoming.resume();
				socket.destroy();
			});
			peer.once('upgrade', (incoming, remote, remoteHead) => {
				clearTimeout(timer);
				try {
					const headers = responseHeaders(incoming, entry, origin);
					headers.connection = 'Upgrade';
					headers.upgrade = 'websocket';
					const lines = Object.entries(headers).flatMap(([name, values]) =>
						(Array.isArray(values) ? values : [values])
							.filter((value) => value !== undefined)
							.map((value) => `${name}: ${value}`)
					);
					socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
					if (remoteHead.length) socket.write(remoteHead);
					if (head.length) remote.write(head);
					socket.once('close', () => remote.destroy());
					remote.once('close', () => socket.destroy());
					remote.once('error', () => socket.destroy());
					socket.pipe(remote).pipe(socket);
				} catch {
					remote.destroy();
					socket.destroy();
				}
			});
			peer.end();
		} catch {
			socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
		}
	}

	/** Retire only confirmed vanished/stopped/changed services; transient Docker failures keep intents. */
	async function reconcile() {
		for (const entry of [...journal.entries]) {
			let remove = false;
			try {
				const info = await lookup(entry.id);
				try {
					remove = binding(info, entry.id, entry.port) !== entry.hostPort;
				} catch {
					remove = true;
				}
			} catch (error) {
				remove = Boolean(
					error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404
				);
			}
			if (remove) await retire(entry);
		}
	}

	const server = http.createServer((request, response) => {
		void handle(request, response);
	});
	server.on('upgrade', (request, socket, head) => {
		void upgrade(request, socket, head);
	});
	try {
		try {
			journal = parseJournal(JSON.parse(await readFile(settings.stateFile, 'utf8')));
		} catch (error) {
			if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
				throw error;
		}
		await client.get();
		// Every old entry is stale after startup. Conditional removal never touches operator edits.
		for (const entry of [...journal.entries]) await retire(entry);
		await persist();
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(settings.listenPort, '127.0.0.1', resolve);
		});
	} catch (error) {
		await rm(lock, { recursive: true, force: true });
		throw error;
	}
	server.on('error', (error) => console.error('[tailscale] Listener error:', error.message));
	let reconciling = false;
	const timer = setInterval(() => {
		if (closing || reconciling) return;
		reconciling = true;
		void serial(reconcile)
			.catch(() => console.error('[tailscale] Reconciliation failed; will retry'))
			.finally(() => {
				reconciling = false;
			});
	}, options.reconcileMs ?? 5000);
	timer.unref();

	/** Stop connections and conditionally remove owned listeners before releasing the journal lock. */
	async function close() {
		closing = true;
		clearInterval(timer);
		for (const response of responses) response.destroy();
		for (const socket of upgrades) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		try {
			await serial(async () => {
				for (const entry of [...journal.entries]) await retire(entry);
			});
		} finally {
			if (shared.__ddashTailscaleRuntime === runtime) delete shared.__ddashTailscaleRuntime;
			await rm(lock, { recursive: true, force: true });
		}
	}
	const runtime = { ensure, close };
	shared.__ddashTailscaleRuntime = runtime;
	return runtime;
}
