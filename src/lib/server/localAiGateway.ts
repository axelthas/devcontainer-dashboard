/** A dedicated application origin, not a path proxy. Dashboard sessions gate HTTP and WS. */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

type Options = {
	port: number;
	origins: string[];
	upstream: () => number | undefined;
	authenticated: (cookie: string | undefined, touch?: boolean) => boolean;
};
const SESSION = 'devcontainer-dashboard-session';
const PREFIX = 'ddash-local-ai-';

/** Remove hop headers and caller-controlled proxy identity. */
function clean(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
	const blocked = new Set([
		'host', 'connection', 'upgrade', 'keep-alive', 'transfer-encoding', 'te',
		'trailer', 'proxy-authorization', 'proxy-authenticate', 'forwarded',
		...(headers.connection ?? '').split(',').map((part) => part.trim().toLowerCase())
	]);
	return Object.fromEntries(Object.entries(headers).filter(([name]) =>
		!blocked.has(name) && !name.startsWith('x-forwarded-') && !name.startsWith('tailscale-')
	));
}

/** Do not forward a dashboard credential or another service's cookies. */
export function aiRequestHeaders(request: IncomingMessage, origin: string) {
	const headers = clean(request.headers);
	delete headers.authorization;
	delete headers.cookie;
	delete headers.referer;
	const cookies = (request.headers.cookie ?? '').split(';').flatMap((part) => {
		const value = part.trim();
		if (!value.startsWith(PREFIX)) return [];
		const pair = value.slice(PREFIX.length);
		if (pair.split('=')[0] === SESSION || pair.startsWith('__Host-')) return [];
		return [pair];
	});
	if (cookies.length) headers.cookie = cookies.join('; ');
	headers.host = new URL(origin).host;
	headers['x-forwarded-host'] = headers.host;
	headers['x-forwarded-proto'] = new URL(origin).protocol.slice(0, -1);
	return headers;
}

/** Keep the upstream's frame policy, but prevent cookie, redirect and site-state escalation. */
function responseHeaders(incoming: IncomingMessage, origin: string, port: number) {
	const headers = clean(incoming.headers);
	for (const name of Object.keys(headers)) {
		if (name.startsWith('access-control-')) delete headers[name];
	}
	for (const name of ['set-cookie', 'clear-site-data', 'alt-svc', 'service-worker-allowed']) delete headers[name];
	headers['cache-control'] = 'no-store';
	headers['referrer-policy'] = 'no-referrer';
	headers['set-cookie'] = incoming.headers['set-cookie']?.flatMap((cookie) => {
		const [pair, ...attributes] = cookie.split(';');
		const name = pair.split('=')[0].trim();
		if (!pair.includes('=') || name === SESSION || name.startsWith('__Host-')) return [];
		return [[`${PREFIX}${pair.trim()}`, ...attributes.filter((part) =>
			!/^\s*(domain|path|secure|httponly)\s*(=|$)/i.test(part)
		), 'Path=/', 'HttpOnly', ...(origin.startsWith('https:') ? ['Secure'] : [])].join('; ')];
	});
	if (!headers['set-cookie']) delete headers['set-cookie'];
	if (incoming.headers.location) {
		const location = new URL(incoming.headers.location, origin);
		if (![origin, `http://127.0.0.1:${port}`].includes(location.origin)) throw new Error('Unsafe redirect');
		headers.location = `${origin}${location.pathname}${location.search}${location.hash}`;
	}
	return headers;
}

/** Start one root-origin proxy; all targets come from the owned process supervisor. */
export async function startAiGateway(options: Options) {
	const sockets = new Set<Duplex>();
	let closing = false;
	function authorize(request: IncomingMessage, upgrade: boolean) {
		const origin = options.origins.find((value) => new URL(value).host === request.headers.host);
		const port = options.upstream();
		if (closing || !origin || !port || !options.authenticated(request.headers.cookie)) throw new Error('Unavailable');
		if (
			(request.headers.origin && request.headers.origin !== origin) ||
			((upgrade || !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '')) && request.headers.origin !== origin) ||
			request.headers['service-worker'] ||
			(!request.headers.origin && request.headers['sec-fetch-site'] === 'cross-site' &&
				request.headers['sec-fetch-mode'] !== 'navigate') ||
			!request.url?.startsWith('/') || request.url.startsWith('//')
		) throw new Error('Origin rejected');
		return { origin, port };
	}
	function connect(request: IncomingMessage, origin: string, port: number) {
		return http.request({ hostname: '127.0.0.1', port, path: request.url,
			method: request.method, headers: aiRequestHeaders(request, origin) });
	}
	function lease(request: IncomingMessage, close: () => void) {
		const timer = setInterval(() => {
			if (closing || !options.upstream() || !options.authenticated(request.headers.cookie, false)) close();
		}, 1000);
		timer.unref();
		return timer;
	}
	function fail(response: ServerResponse, status: number) {
		response.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
		response.end('Reopen OpenChamber from the dashboard. Check Local AI service status.');
	}
	const server = http.createServer((request, response) => {
		try {
			const { origin, port } = authorize(request, false);
			const peer = connect(request, origin, port);
			const timer = setTimeout(() => peer.destroy(new Error('Response timeout')), 15_000);
			const authTimer = lease(request, () => response.destroy());
			response.once('close', () => { clearTimeout(timer); clearInterval(authTimer); peer.destroy(); });
			request.once('aborted', () => peer.destroy());
			peer.on('error', () => {
				clearTimeout(timer);
				if (response.destroyed) return;
				if (response.headersSent) response.destroy(); else fail(response, 502);
			});
			peer.once('response', (incoming) => {
				clearTimeout(timer);
				try {
					response.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming, origin, port));
					incoming.on('error', () => response.destroy());
					incoming.on('aborted', () => response.destroy());
					incoming.pipe(response);
				} catch { incoming.destroy(); fail(response, 502); }
			});
			request.pipe(peer);
		} catch { fail(response, 403); }
	});
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.on('error', () => socket.destroy());
		socket.once('close', () => sockets.delete(socket));
	});
	server.on('upgrade', (request, socket, head) => {
		try {
			const { origin, port } = authorize(request, true);
			if (request.headers.upgrade?.toLowerCase() !== 'websocket') throw new Error('Not WebSocket');
			const peer = connect(request, origin, port);
			peer.setHeader('connection', 'Upgrade');
			peer.setHeader('upgrade', 'websocket');
			const timer = setTimeout(() => peer.destroy(), 15_000);
			const authTimer = lease(request, () => socket.destroy());
			socket.once('close', () => { clearTimeout(timer); clearInterval(authTimer); peer.destroy(); });
			peer.on('error', () => socket.destroy());
			peer.once('response', (incoming) => { incoming.resume(); socket.destroy(); });
			peer.once('upgrade', (incoming, remote, remoteHead) => {
				clearTimeout(timer);
				try {
					const headers = responseHeaders(incoming, origin, port);
					headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
					const lines = Object.entries(headers).flatMap(([name, values]) =>
						(Array.isArray(values) ? values : [values]).filter((value) => value !== undefined)
							.map((value) => `${name}: ${value}`));
					socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
					if (head.length) remote.write(head);
					if (remoteHead.length) socket.write(remoteHead);
					remote.on('error', () => socket.destroy());
					remote.once('close', () => socket.destroy());
					socket.once('close', () => remote.destroy());
					socket.pipe(remote).pipe(socket);
				} catch { remote.destroy(); socket.destroy(); }
			});
			peer.end();
		} catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port, '0.0.0.0', resolve);
	});
	return {
		close: async () => {
			closing = true;
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	};
}
