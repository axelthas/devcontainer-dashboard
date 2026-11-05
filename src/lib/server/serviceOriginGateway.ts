/**
 * Root-origin listener with a fragment-based login handoff.
 * All non-control traffic uses the existing streaming gateway, never SvelteKit.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { createServiceGateway, type GatewayOptions } from './serviceGateway.js';
import type { ServiceOrigin } from './serviceOriginConfig.js';
import {
	exchangeServiceLaunch,
	isServiceSessionValid,
	serviceCookiePrefix
} from './serviceOriginAuth.js';

interface OriginGatewayOptions extends Omit<GatewayOptions, 'origin' | 'authenticated' | 'service'> {
	route: ServiceOrigin;
	dashboardOrigin: string;
	leaseMs?: number;
}

/** Send bounded, non-cacheable control responses without reflecting request inputs. */
function reply(response: ServerResponse, status: number, body: string): void {
	response.writeHead(status, {
		'Content-Type': 'text/plain; charset=utf-8',
		'Cache-Control': 'no-store',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff'
	});
	response.end(body);
}

/** Read a tiny launch-ticket body without buffering an unbounded request. */
async function ticketBody(request: IncomingMessage): Promise<string> {
	let body = '';
	for await (const chunk of request) {
		body += chunk.toString();
		if (body.length > 128) throw new Error('Launch ticket too large.');
	}
	if (!/^[a-zA-Z0-9_-]{43}$/.test(body)) throw new Error('Invalid launch ticket.');
	return body;
}

/** Make an independently testable HTTP listener; TLS is terminated by Tailscale Serve. */
export function createServiceOriginServer(options: OriginGatewayOptions) {
	const { route } = options;
	const valid = (cookie: string | undefined) => isServiceSessionValid(route, cookie);
	const gateway = createServiceGateway({
		...options,
		origin: route.origin,
		authenticated: valid,
		service: {
			containerId: route.containerId,
			containerPort: route.containerPort,
			cookieNamespace: serviceCookiePrefix(route)
		}
	});

	/** Close long-lived streams/upgrades shortly after logout or session expiry. */
	function lease(cookie: string | undefined, close: () => void): NodeJS.Timeout {
		const timer = setInterval(() => {
			if (!valid(cookie)) close();
		}, options.leaseMs ?? 1000);
		timer.unref();
		return timer;
	}

	/** Reject cross-origin requests even when a same-host browser sends service cookies. */
	function allowed(request: IncomingMessage): boolean {
		const origin = request.headers.origin;
		if (origin && origin !== route.origin) return false;
		const site = request.headers['sec-fetch-site'];
		if (
			!origin &&
			site &&
			site !== 'same-origin' &&
			site !== 'none' &&
			request.headers['sec-fetch-mode'] !== 'navigate'
		) return false;
		if (request.headers['service-worker']) return false;
		return true;
	}

	/** Serve the ticket bridge or hand all application paths to the root proxy. */
	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!allowed(request)) return reply(response, 403, 'Service origin required.');
		if (request.url === '/__ddash/launch' && request.method === 'GET') {
			const nonce = randomBytes(18).toString('base64');
			response.writeHead(200, {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
				'Referrer-Policy': 'no-referrer',
				'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors ${options.dashboardOrigin}`,
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
			return;
		}
		if (request.url === '/__ddash/session' && request.method === 'POST') {
			if (request.headers.origin !== route.origin) return reply(response, 403, 'Origin required.');
			try {
				const token = exchangeServiceLaunch(route, await ticketBody(request));
				if (!token) return reply(response, 401, 'Launch expired. Reopen from the dashboard.');
				response.setHeader('Set-Cookie',
					`${serviceCookiePrefix(route)}session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`);
				return reply(response, 204, '');
			} catch {
				return reply(response, 400, 'Invalid launch ticket.');
			}
		}
		if (request.url?.startsWith('/__ddash/')) return reply(response, 404, 'Unknown control route.');
		const timer = lease(request.headers.cookie, () => response.destroy());
		response.once('close', () => clearInterval(timer));
		await gateway.handle(request, response);
	}

	const server = createServer((request, response) => {
		void handle(request, response).catch(() => {
			if (response.headersSent) response.destroy();
			else reply(response, 502, 'Service unavailable.');
		});
	});
	server.requestTimeout = 60_000;
	server.headersTimeout = 15_000;
	server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		if (
			request.url?.startsWith('/__ddash/') ||
			!allowed(request) ||
			request.headers.origin !== route.origin
		) {
			socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
			return;
		}
		const timer = lease(request.headers.cookie, () => socket.destroy());
		socket.once('close', () => clearInterval(timer));
		void gateway.upgrade(request, socket, head);
	});
	return server;
}
