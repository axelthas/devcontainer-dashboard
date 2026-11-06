/**
 * One listener for every service subdomain. The Host header selects the origin; the
 * authenticated session grant, never the request, selects the full Docker identity.
 * The caller terminates TLS (the production HTTPS server or a test HTTP server).
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { createServiceGateway, type GatewayOptions } from './serviceGateway.js';
import { parseServiceHost, type ServiceHost, type SubdomainConfig } from './serviceSubdomains.js';
import {
	SERVICE_SESSION_COOKIE,
	exchangeServiceLaunch,
	serviceSessionRoute
} from './serviceOriginAuth.js';

type BaseOptions = Omit<GatewayOptions, 'origin' | 'authenticated' | 'service'>;

export interface SubdomainGatewayOptions extends BaseOptions {
	config: SubdomainConfig;
	/** Interval for revalidating long-lived streams and upgrades; default one second. */
	leaseMs?: number;
}

/** Send a bounded, non-cacheable control response without reflecting request input. */
function reply(response: ServerResponse, status: number, body: string): void {
	response.writeHead(status, {
		'Content-Type': 'text/plain; charset=utf-8',
		'Cache-Control': 'no-store',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff'
	});
	response.end(body);
}

/** Refuse an upgrade before any upstream connection exists. */
function refuse(socket: Duplex, status: string): void {
	socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Read a small launch-ticket body without buffering an unbounded request. */
async function ticketBody(request: IncomingMessage): Promise<string> {
	let body = '';
	for await (const chunk of request) {
		body += chunk.toString();
		if (body.length > 128) throw new Error('Launch ticket too large.');
	}
	if (!/^[a-zA-Z0-9_-]{43}$/.test(body)) throw new Error('Invalid launch ticket.');
	return body;
}

/** Reject cross-origin browser requests: sibling subdomains are same-site, not same-origin. */
function sameOrigin(request: IncomingMessage, origin: string): boolean {
	const requestOrigin = request.headers.origin;
	if (requestOrigin && requestOrigin !== origin) return false;
	const site = request.headers['sec-fetch-site'];
	const crossSite = site !== undefined && site !== 'same-origin' && site !== 'none';
	if (!requestOrigin && crossSite && request.headers['sec-fetch-mode'] !== 'navigate') {
		return false;
	}
	// A service worker could outlive logout and intercept later requests.
	return !request.headers['service-worker'];
}

/** Serve an inert bridge page that exchanges the fragment ticket, then loads the app root. */
function bridge(response: ServerResponse, dashboardOrigin: string): void {
	const nonce = randomBytes(18).toString('base64');
	const policy = [
		"default-src 'none'",
		`script-src 'nonce-${nonce}'`,
		"connect-src 'self'",
		"base-uri 'none'",
		`frame-ancestors ${dashboardOrigin}`
	].join('; ');
	response.writeHead(200, {
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store',
		'Referrer-Policy': 'no-referrer',
		'Content-Security-Policy': policy,
		'X-Content-Type-Options': 'nosniff'
	});
	response.end(`<!doctype html><meta charset="utf-8"><title>Opening service</title>
<p id="status">Opening service...</p><script nonce="${nonce}">
const ticket = location.hash.slice(1);
history.replaceState(null, '', '/__ddash/launch');
fetch('/__ddash/session', {method:'POST', body:ticket, credentials:'same-origin'})
.then(r => {if (!r.ok) throw new Error(); location.replace('/');})
.catch(() => {document.getElementById('status').textContent =
'Launch expired or unavailable. Open the service again from the dashboard.';});
</script>`);
}

/** Create HTTP and upgrade handlers for all service subdomains. */
export function createSubdomainGateway(options: SubdomainGatewayOptions) {
	const { config, leaseMs = 1000, ...gatewayOptions } = options;

	/** Build a per-request proxy bound to the grant's full container identity. */
	function proxyFor(host: ServiceHost, containerId: string) {
		return createServiceGateway({
			...gatewayOptions,
			origin: host.origin,
			authenticated: (cookie) =>
				serviceSessionRoute(host.origin, cookie)?.containerId === containerId,
			service: { containerId, containerPort: host.containerPort }
		});
	}

	/** Close a long-lived stream or upgrade shortly after logout or session expiry. */
	function lease(host: ServiceHost, cookie: string | undefined, close: () => void) {
		const timer = setInterval(() => {
			if (!serviceSessionRoute(host.origin, cookie)) close();
		}, leaseMs);
		timer.unref();
		return timer;
	}

	/** Exchange a launch ticket for a host-only service session cookie. */
	async function exchange(request: IncomingMessage, response: ServerResponse, host: ServiceHost) {
		if (request.headers.origin !== host.origin) return reply(response, 403, 'Origin required.');
		let token: string | undefined;
		try {
			token = exchangeServiceLaunch(host.origin, await ticketBody(request));
		} catch {
			return reply(response, 400, 'Invalid launch ticket.');
		}
		if (!token) return reply(response, 401, 'Launch expired. Reopen it from the dashboard.');
		response.setHeader(
			'Set-Cookie',
			`${SERVICE_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`
		);
		reply(response, 204, '');
	}

	/** Route control paths, then authenticate and proxy application paths at '/'. */
	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const host = parseServiceHost(config, request.headers.host);
		if (!host) return reply(response, 421, 'Unknown service host.');
		if (!sameOrigin(request, host.origin)) return reply(response, 403, 'Service origin required.');
		if (request.url === '/__ddash/launch' && request.method === 'GET') {
			return bridge(response, config.dashboardOrigin);
		}
		if (request.url === '/__ddash/session' && request.method === 'POST') {
			return exchange(request, response, host);
		}
		if (request.url?.startsWith('/__ddash/')) return reply(response, 404, 'Unknown control route.');
		// Authenticate before Docker access; the grant supplies the container identity.
		const route = serviceSessionRoute(host.origin, request.headers.cookie);
		if (!route) return reply(response, 401, 'Open this service from the dashboard.');
		const timer = lease(host, request.headers.cookie, () => response.destroy());
		response.once('close', () => clearInterval(timer));
		await proxyFor(host, route.containerId).handle(request, response);
	}

	/** Authenticate a WebSocket upgrade, keeping the application's original root path. */
	function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		const host = parseServiceHost(config, request.headers.host);
		if (
			!host ||
			request.url?.startsWith('/__ddash/') ||
			!sameOrigin(request, host.origin) ||
			request.headers.origin !== host.origin
		) {
			return refuse(socket, '403 Forbidden');
		}
		const route = serviceSessionRoute(host.origin, request.headers.cookie);
		if (!route) return refuse(socket, '401 Unauthorized');
		const timer = lease(host, request.headers.cookie, () => socket.destroy());
		socket.once('close', () => clearInterval(timer));
		void proxyFor(host, route.containerId).upgrade(request, socket, head);
	}

	return {
		handle: (request: IncomingMessage, response: ServerResponse) => {
			void handle(request, response).catch(() => {
				if (response.headersSent) response.destroy();
				else reply(response, 502, 'Service unavailable.');
			});
		},
		upgrade
	};
}
