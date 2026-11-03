/**
 * Authenticated streaming gateway for trusted container web applications.
 * Upstream applications must support their configured public base path.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { isIP } from 'node:net';

const PREFIX = '/service-proxy/';
const SESSION_COOKIE = 'devcontainer-dashboard-session';
const HOP_HEADERS = [
	'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
	'te', 'trailer', 'transfer-encoding', 'upgrade'
];
const DEFAULT_PORTS: Record<string, 'http' | 'https'> = {
	'80': 'http', '443': 'https', '4096': 'http',
	'6904': 'http', '8000': 'http', '8080': 'http', '9001': 'http'
};

export interface ContainerInspection {
	Id: string;
	State: { Running: boolean };
	NetworkSettings: {
		Ports?: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
		Networks?: Record<string, { IPAddress?: string }>;
	};
}

export interface GatewayOptions {
	inspect: (id: string) => Promise<ContainerInspection>;
	authenticated: (cookie: string | undefined) => boolean;
	/** Exact browser-facing origin, required for mutations and WebSocket upgrades. */
	origin: string;
	/** Operator-controlled route to published ports, never read from a request. */
	upstreamHost?: string;
	ports?: Record<string, 'http' | 'https'>;
	connectTimeoutMs?: number;
}

interface Target {
	protocol: 'http:' | 'https:';
	hostname: string;
	port: number;
	path: string;
	prefix: string;
}

/** Expose bounded diagnostics instead of internal upstream exceptions. */
class GatewayError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}

/** Parse the raw path before URL normalization can hide traversal attempts. */
export function parseServicePath(raw: string): {
	id: string; port: string; path: string; prefix: string;
} | null {
	if (!raw.startsWith(PREFIX)) return null;
	const match = /^\/service-proxy\/([a-f0-9]{12,64})\/([1-9][0-9]{0,4})(\/[^#]*)?$/.exec(raw);
	if (!match || Number(match[2]) > 65535) throw new GatewayError(400, 'Invalid service identity or path.');
	const path = match[3] ?? '/';
	const pathname = path.split('?')[0];
	// Reject ambiguous decoding rather than guessing the upstream's decoding rules.
	if (pathname.startsWith('//') || /%(?:2f|5c|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(pathname) || /[\\\x00-\x20]/.test(pathname)) {
		throw new GatewayError(400, 'Invalid service path.');
	}
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		throw new GatewayError(400, 'Invalid service path.');
	}
	if (decoded.split('/').some((part) => part === '.' || part === '..')) {
		throw new GatewayError(400, 'Service path traversal is not allowed.');
	}
	return { id: match[1], port: match[2], path, prefix: `${PREFIX}${match[1]}/${match[2]}/` };
}

/** Drop hop-by-hop headers, including additional names listed by Connection. */
export function cleanHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
	const blocked = new Set([
		...HOP_HEADERS,
		...(headers.connection ?? '').split(',').map((name) => name.trim().toLowerCase()),
		'host', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto',
		'x-forwarded-for', 'x-forwarded-port', 'x-forwarded-prefix'
	]);
	return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name)));
}

/** Do not forward dashboard credentials, origins, or referrers to services. */
function requestHeaders(request: IncomingMessage, target: Target): http.OutgoingHttpHeaders {
	const headers = cleanHeaders(request.headers);
	delete headers.authorization;
	delete headers.origin;
	delete headers.referer;
	const cookies = request.headers.cookie?.split(';').filter((cookie) => {
		const name = cookie.split('=')[0].trim();
		return name !== SESSION_COOKIE && !name.startsWith('__Host-');
	}).join(';');
	if (cookies) headers.cookie = cookies;
	else delete headers.cookie;
	headers['x-forwarded-prefix'] = target.prefix.slice(0, -1);
	return headers;
}

/** Scope service cookies to their prefix and protect the dashboard cookie name. */
function scopeCookies(cookies: string[] | undefined, prefix: string): string[] | undefined {
	return cookies?.flatMap((cookie) => {
		const parts = cookie.split(';');
		const name = parts[0].split('=')[0].trim();
		if (name === SESSION_COOKIE || name.startsWith('__Host-')) return [];
		return [[
			parts[0],
			...parts.slice(1).filter((part) => !/^\s*(?:domain|path)\s*=/i.test(part)),
			`Path=${prefix}`
		].join(';')];
	});
}

/** Rewrite redirects within this upstream, without weakening frame restrictions. */
function responseHeaders(upstream: IncomingMessage, target: Target): http.OutgoingHttpHeaders {
	const headers = cleanHeaders(upstream.headers);
	// An upstream CORS policy must not grant browser access to dashboard-origin data.
	for (const name of Object.keys(headers)) {
		if (name.startsWith('access-control-')) delete headers[name];
	}
	headers['cache-control'] = 'no-store';
	delete headers['service-worker-allowed'];
	const cookies = scopeCookies(upstream.headers['set-cookie'], target.prefix);
	if (cookies?.length) headers['set-cookie'] = cookies;
	else delete headers['set-cookie'];
	if (upstream.headers.location) {
		const host = target.hostname.includes(':') ? `[${target.hostname}]` : target.hostname;
		const base = new URL(target.path, `${target.protocol}//${host}:${target.port}`);
		const redirect = new URL(upstream.headers.location, base);
		if (redirect.origin !== base.origin) {
			throw new GatewayError(502, 'Service redirected to another origin. Configure a dedicated HTTPS service origin.');
		}
		headers.location = `${target.prefix}${redirect.pathname.slice(1)}${redirect.search}${redirect.hash}`;
	}
	return headers;
}

/** Authenticate before Docker access; require a matching Origin on writes and upgrades. */
function authorize(request: IncomingMessage, options: GatewayOptions, upgrade: boolean): void {
	if (!options.authenticated(request.headers.cookie)) throw new GatewayError(401, 'Sign in to the dashboard again.');
	if (upgrade || !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '')) {
		if (!request.headers.origin || request.headers.origin !== options.origin) {
			throw new GatewayError(403, 'A matching dashboard Origin is required.');
		}
	}
}

/** Revalidate the running container and its TCP port for every incoming request. */
async function resolveTarget(raw: string, options: GatewayOptions): Promise<Target> {
	const parsed = parseServicePath(raw);
	if (!parsed) throw new GatewayError(404, 'Unknown service route.');
	const scheme = (options.ports ?? DEFAULT_PORTS)[parsed.port];
	if (scheme !== 'http' && scheme !== 'https') throw new GatewayError(422, 'This port is not an enabled web service.');
	let info: ContainerInspection;
	try {
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			info = await Promise.race([
				options.inspect(parsed.id),
				new Promise<never>((_resolve, reject) => {
					deadline = setTimeout(() => reject(new Error('Docker lookup timeout')), options.connectTimeoutMs ?? 10000);
				})
			]);
		} finally {
			clearTimeout(deadline);
		}
	} catch {
		throw new GatewayError(404, 'Container is no longer available.');
	}
	if (!info.Id.startsWith(parsed.id) || !info.State.Running) throw new GatewayError(409, 'Container is not running.');
	const bindings = info.NetworkSettings.Ports?.[`${parsed.port}/tcp`];
	if (!bindings?.length) throw new GatewayError(404, 'Service has no published TCP binding.');
	let hostname: string;
	let port: number;
	if (options.upstreamHost) {
		if (!/^[a-zA-Z0-9.:-]+$/.test(options.upstreamHost)) throw new GatewayError(503, 'Invalid configured service host.');
		hostname = options.upstreamHost;
		if (new Set(bindings.map((binding) => binding.HostPort)).size !== 1) {
			throw new GatewayError(503, 'Service has ambiguous published ports.');
		}
		port = Number(bindings[0].HostPort);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new GatewayError(503, 'Invalid published service port.');
	} else {
		// Do not mistake dashboard loopback for Docker-host loopback.
		// This direct container route still requires compatible Docker network policy.
		const addresses = [...new Set(Object.values(info.NetworkSettings.Networks ?? {})
			.map((network) => network.IPAddress).filter((address): address is string => Boolean(address)))];
		if (addresses.length !== 1 || !isIP(addresses[0])) {
			throw new GatewayError(503, 'Configure SERVICE_PROXY_HOST or a single reachable container network.');
		}
		hostname = addresses[0];
		port = Number(parsed.port);
	}
	return { protocol: `${scheme}:`, hostname, port, path: parsed.path, prefix: parsed.prefix };
}

/** Convert internal errors to safe public diagnostics. */
function failure(error: unknown): { status: number; message: string } {
	return error instanceof GatewayError
		? { status: error.status, message: error.message }
		: { status: 502, message: 'Service is unreachable. Check Docker routing, the service base path, and SERVICE_PROXY_HOST.' };
}

/** Create an upstream request without disabling HTTPS certificate verification. */
function upstreamRequest(request: IncomingMessage, target: Target): http.ClientRequest {
	return (target.protocol === 'https:' ? https : http).request({
		protocol: target.protocol, hostname: target.hostname, port: target.port,
		path: target.path, method: request.method, headers: requestHeaders(request, target)
	});
}

/** Create handlers shared by the production server and Vite development middleware. */
export function createServiceGateway(options: GatewayOptions) {
	/** Stream HTTP bodies and SSE with backpressure and disconnect cleanup. */
	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			authorize(request, options, false);
			const target = await resolveTarget(request.url ?? '', options);
			if (request.destroyed || response.destroyed) return;
			const upstream = upstreamRequest(request, target);
			const deadline = setTimeout(() => upstream.destroy(new Error('Service response timeout')), options.connectTimeoutMs ?? 10000);
			const stop = () => upstream.destroy();
			request.once('aborted', stop);
			response.once('close', stop);
			upstream.once('error', (error) => {
				clearTimeout(deadline);
				if (response.destroyed) return;
				if (response.headersSent) response.destroy();
				else {
					const result = failure(error);
					response.writeHead(result.status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
					response.end(result.message);
				}
			});
			upstream.once('response', (incoming) => {
				clearTimeout(deadline);
				try {
					response.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming, target));
					incoming.once('error', () => response.destroy());
					incoming.once('aborted', () => response.destroy());
					incoming.pipe(response);
				} catch (error) {
					incoming.destroy();
					upstream.destroy();
					const result = failure(error);
					response.writeHead(result.status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
					response.end(result.message);
				}
			});
			request.pipe(upstream);
		} catch (error) {
			const result = failure(error);
			response.writeHead(result.status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
			response.end(result.message);
		}
	}

	/** Tunnel only this gateway's authenticated WebSocket upgrade requests. */
	async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		let upstream: http.ClientRequest | undefined;
		// A client can disconnect while Docker inspection is still pending.
		socket.on('error', () => socket.destroy());
		try {
			authorize(request, options, true);
			const target = await resolveTarget(request.url ?? '', options);
			if (socket.destroyed) return;
			if (request.headers.upgrade?.toLowerCase() !== 'websocket') throw new GatewayError(400, 'Only WebSocket upgrades are supported.');
			upstream = upstreamRequest(request, target);
			upstream.setHeader('connection', 'Upgrade');
			upstream.setHeader('upgrade', 'websocket');
			const deadline = setTimeout(() => upstream?.destroy(new Error('Service upgrade timeout')), options.connectTimeoutMs ?? 10000);
			socket.once('close', () => upstream?.destroy());
			upstream.once('error', () => {
				clearTimeout(deadline);
				if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
			});
			upstream.once('response', (incoming) => {
				clearTimeout(deadline);
				incoming.resume();
				socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
			});
			upstream.once('upgrade', (incoming, peer, peerHead) => {
				clearTimeout(deadline);
				try {
					const headers = responseHeaders(incoming, target);
					headers.connection = 'Upgrade';
					headers.upgrade = 'websocket';
					const lines = Object.entries(headers).flatMap(([name, value]) =>
						(Array.isArray(value) ? value : [value]).filter((item) => item !== undefined).map((item) => `${name}: ${item}`));
					socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
					if (peerHead.length) socket.write(peerHead);
					if (head.length) peer.write(head);
					peer.once('error', () => socket.destroy());
					socket.once('error', () => peer.destroy());
					socket.once('close', () => peer.destroy());
					peer.once('close', () => socket.destroy());
					socket.pipe(peer).pipe(socket);
				} catch {
					peer.destroy();
					socket.destroy();
				}
			});
			upstream.end();
		} catch (error) {
			upstream?.destroy();
			const result = failure(error);
			socket.end(`HTTP/1.1 ${result.status} Service Gateway Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
		}
	}

	return {
		matches: (raw: string | undefined) => Boolean(raw?.startsWith(PREFIX)),
		handle,
		upgrade
	};
}
