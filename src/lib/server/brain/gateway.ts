/**
 * Dedicated HTTP listener for the Brain MCP endpoint. It is separate from the dashboard
 * listener, so publishing it (for example with Tailscale Funnel) never exposes the dashboard
 * UI, its cookies or its other routes. Every request needs the bearer token.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { pruneExpiredGrants } from './access.js';
import { handleMcpMessage, type JsonRpcResponse } from './mcp.js';
import { brainState } from './state.js';

export interface BrainSettings {
	token: string;
	port: number;
	publicUrl?: string;
}

export const MCP_PATH = '/mcp';
export const MIN_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 1_048_576;
const MAX_CONCURRENT_REQUESTS = 32;

/**
 * Read the opt-in configuration. No token: the endpoint is disabled. An invalid value fails
 * startup rather than running with a weak or missing credential.
 */
export function brainSettings(env: Record<string, string | undefined>): BrainSettings | null {
	const inline = env.BRAIN_MCP_TOKEN;
	const file = env.BRAIN_MCP_TOKEN_FILE;
	if (inline && file) throw new Error('Set BRAIN_MCP_TOKEN or BRAIN_MCP_TOKEN_FILE, not both');
	if (!inline && !file) return null;
	let token = inline ?? '';
	if (file) {
		if (!file.startsWith('/')) throw new Error('BRAIN_MCP_TOKEN_FILE must be an absolute path');
		token = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
	}
	if (token.length < MIN_TOKEN_LENGTH || token.length > 512 || /\s/.test(token))
		throw new Error(
			`The Brain MCP token must be ${MIN_TOKEN_LENGTH} to 512 characters without whitespace`
		);
	const rawPort = env.BRAIN_MCP_PORT || '3100';
	const port = Number(rawPort);
	if (!/^\d{1,5}$/.test(rawPort) || port < 1 || port > 65535)
		throw new Error('BRAIN_MCP_PORT must be from 1 to 65535');
	const publicUrl = env.BRAIN_MCP_PUBLIC_URL || undefined;
	if (publicUrl) {
		let parsed: URL;
		try {
			parsed = new URL(publicUrl);
		} catch {
			throw new Error('BRAIN_MCP_PUBLIC_URL must be an absolute HTTPS URL');
		}
		if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
			throw new Error('BRAIN_MCP_PUBLIC_URL must be an HTTPS URL without credentials');
	}
	return { token, port, publicUrl };
}

/** Compare fixed-length digests, so timing reveals neither content nor length. */
export function bearerMatches(header: string | undefined, token: string): boolean {
	const match = header ? /^Bearer ([^\s]+)$/i.exec(header) : null;
	if (!match) return false;
	const digest = (value: string) => createHash('sha256').update(value).digest();
	return timingSafeEqual(digest(match[1]), digest(token));
}

/** Write a JSON body, or an empty body when `body` is undefined. */
function send(
	response: ServerResponse,
	status: number,
	body?: unknown,
	headers: Record<string, string> = {}
): void {
	const payload = body === undefined ? undefined : JSON.stringify(body);
	response.writeHead(status, {
		'Cache-Control': 'no-store',
		...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
		...headers
	});
	response.end(payload);
}

class BodyTooLarge extends Error {}

/** Read the request body up to the limit. */
function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new BodyTooLarge());
				request.removeAllListeners('data');
				request.resume();
				return;
			}
			chunks.push(chunk);
		});
		request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		request.once('error', reject);
	});
}

/** Create the listener. The caller decides the port and address. */
export function createBrainServer(
	settings: BrainSettings,
	handle: (message: unknown) => Promise<JsonRpcResponse | null> = handleMcpMessage
): Server {
	brainState.gateway = { publicUrl: settings.publicUrl };
	let active = 0;
	// Expired grants also end while nobody calls the endpoint or opens the dashboard.
	const sweep = setInterval(() => pruneExpiredGrants(), 5000);
	sweep.unref();

	async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const path = new URL(request.url ?? '/', 'http://localhost').pathname;
		if (path !== MCP_PATH) return send(response, 404, { error: 'Not found' });
		if (!bearerMatches(request.headers.authorization, settings.token))
			return send(
				response,
				401,
				{ error: 'Authentication required' },
				{ 'WWW-Authenticate': 'Bearer realm="devcontainer-dashboard"' }
			);
		// Brain calls server to server. A browser origin indicates a cross-site request.
		if (request.headers.origin)
			return send(response, 403, { error: 'Browser requests are not accepted' });
		if (request.method !== 'POST')
			return send(response, 405, { error: 'Use POST' }, { Allow: 'POST' });
		if (!/^application\/json\s*(;|$)/i.test(request.headers['content-type'] ?? ''))
			return send(response, 415, { error: 'Content-Type must be application/json' });
		if (active >= MAX_CONCURRENT_REQUESTS)
			return send(response, 503, { error: 'Too many concurrent requests' }, { 'Retry-After': '5' });
		active++;
		try {
			let body: string;
			try {
				body = await readBody(request);
			} catch (cause) {
				if (cause instanceof BodyTooLarge)
					return send(response, 413, { error: 'Request body too large' }, { Connection: 'close' });
				throw cause;
			}
			let message: unknown;
			try {
				message = JSON.parse(body);
			} catch {
				return send(response, 400, {
					jsonrpc: '2.0',
					id: null,
					error: { code: -32700, message: 'Parse error' }
				});
			}
			const reply = await handle(message);
			if (!reply) return send(response, 202);
			send(response, 200, reply);
		} finally {
			active--;
		}
	}

	const server = createServer((request, response) => {
		serve(request, response).catch((cause) => {
			console.error('[brain] request failed', cause);
			if (!response.headersSent) send(response, 500, { error: 'Internal error' });
			else response.destroy();
		});
	});
	server.on('close', () => {
		clearInterval(sweep);
		brainState.gateway = undefined;
	});
	return server;
}
