/**
 * WebSocket transport for Brain terminal tabs on the dashboard listener (never on the MCP
 * listener). Authentication and origin checks are the same as for local terminals. Closing
 * a viewer never stops the command.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { isCookieHeaderAuthenticated } from './auth.js';
import { isTerminalUpgradeAuthorized } from './terminal.js';
import { connectViewer, VIEWER_LIMITS } from './brain/viewers.js';

export const BRAIN_TERMINAL_PATH = '/api/brain/terminal';
const HEARTBEAT_MS = 5000;

/** Reject before any Docker operation. */
function rejectUpgrade(socket: Duplex): void {
	socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

/** Valid execution ID from the query string, or null. */
function executionIdOf(request: IncomingMessage): string | null {
	const id = new URL(request.url ?? '/', 'http://localhost').searchParams.get('executionId');
	return id && /^x_[A-Za-z0-9_-]{1,62}$/.test(id) ? id : null;
}

/** Ping the viewer and close it when the session expires or the peer stops answering. */
function keepAlive(ws: WebSocket, request: IncomingMessage): () => void {
	let alive = true;
	ws.on('pong', () => {
		alive = true;
	});
	const timer = setInterval(() => {
		if (!isCookieHeaderAuthenticated(request.headers.cookie, false)) {
			ws.close(1008, 'Authentication expired. Sign in and retry.');
			return;
		}
		if (!alive) {
			ws.terminate();
			return;
		}
		alive = false;
		ws.ping();
	}, HEARTBEAT_MS);
	timer.unref();
	return () => clearInterval(timer);
}

/** Connect one authenticated socket to a Brain command. */
function serveViewer(ws: WebSocket, request: IncomingMessage): void {
	const id = executionIdOf(request);
	if (!id) {
		ws.close(1008, 'Invalid execution id');
		return;
	}
	const viewer = connectViewer(id, ws);
	if (!viewer) return;
	const stopKeepAlive = keepAlive(ws, request);
	ws.on('error', () => ws.close());
	ws.on('message', (raw) => {
		// Typing is a privileged action: check the session on every message.
		if (!isCookieHeaderAuthenticated(request.headers.cookie)) {
			ws.close(1008, 'Authentication required');
			return;
		}
		viewer.message(raw.toString()).catch((cause) => {
			console.error('[brain] terminal message failed', cause);
			ws.close(1011, 'Terminal message failed');
		});
	});
	ws.on('close', () => {
		stopKeepAlive();
		viewer.close();
	});
}

/** Handle upgrades for Brain terminal tabs. Other paths are left to other handlers. */
export function attachBrainTerminalServer(server: Server): void {
	const wss = new WebSocketServer({ noServer: true, maxPayload: VIEWER_LIMITS.message * 4 });
	server.on('upgrade', (request, socket, head) => {
		const url = new URL(request.url ?? '/', 'http://localhost');
		if (url.pathname !== BRAIN_TERMINAL_PATH) return;
		if (!isTerminalUpgradeAuthorized(request)) {
			rejectUpgrade(socket);
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => serveViewer(ws, request));
	});
}
