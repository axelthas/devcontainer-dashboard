/** Persistent local PTYs. A viewer disconnect never terminates its process. */
import * as pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { IPty } from 'node-pty';
import { isCookieHeaderAuthenticated } from './auth.js';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';
const CANCEL_SIGNALS = new Set([1, 2, 15]);
export type PersistentSessionKind = 'shell' | 'bootstrap' | 'devcontainer-build';
export interface PersistentSessionExit { exitCode: number; signal?: number; output: string; }
interface PersistentSessionOptions {
	name?: string;
	kind?: PersistentSessionKind;
	maxOutputChars?: number;
	onExit?: (exit: PersistentSessionExit) => void;
}
interface PersistentSession {
	pty: IPty;
	name: string;
	kind: PersistentSessionKind;
	startedAt: string;
	maxOutputChars: number;
	outputBuffer: string[];
	outputBufferLength: number;
	viewers: Set<WebSocket>;
	status: 'running' | 'exited';
	exitCode?: number;
}
export interface PersistentSessionInfo {
	id: string;
	name: string;
	kind: PersistentSessionKind;
	startedAt: string;
	status: 'running' | 'exited';
	exitCode?: number;
}
const globalSessions = globalThis as typeof globalThis & { __terminalSessions?: Map<string, PersistentSession> };
const persistentSessions = (globalSessions.__terminalSessions ??= new Map());

/** Require bounded URL-safe identities across creation, attachment, and deletion. */
export function validSessionId(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
/** Accept only explicit supported kinds; do not silently turn malformed kinds into shells. */
export function validSessionKind(value: unknown): value is PersistentSessionKind {
	return value === 'shell' || value === 'bootstrap' || value === 'devcontainer-build';
}
/** Recognize deliberate cancellation without treating every nonzero result as cancellation. */
export function isCancelledExit(exitCode: number, signal?: number): boolean {
	return (signal !== undefined && CANCEL_SIGNALS.has(signal)) || CANCEL_SIGNALS.has(exitCode - 128);
}
/** Do not inherit dashboard credentials or editor-specific launch hooks into children. */
function buildFilteredEnv(): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || key.startsWith('VSCODE_') || ['DASHBOARD_PASSWORD', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'GIT_ASKPASS', 'BROWSER'].includes(key)) continue;
		result[key] = value;
	}
	return { ...result, TERM: 'xterm-256color' };
}
/** Explicit, idempotent creation. Existing and exited IDs never execute a second command. */
export function createPersistentSession(sessionId: string, command: string | undefined, cwd: string, options?: PersistentSessionOptions): void {
	if (!validSessionId(sessionId)) throw new Error('Invalid terminal session id');
	if (options?.kind !== undefined && !validSessionKind(options.kind)) throw new Error('Invalid terminal kind');
	if (persistentSessions.has(sessionId)) return;
	const process = command
		? pty.spawn('/bin/bash', ['-c', command], { name: 'xterm-256color', cols: 120, rows: 30, cwd, env: buildFilteredEnv() })
		: pty.spawn(globalThis.process.env.SHELL ?? '/bin/bash', [], { name: 'xterm-256color', cols: 120, rows: 30, cwd, env: buildFilteredEnv() });
	const session: PersistentSession = { pty: process, name: options?.name ?? 'Shell', kind: options?.kind ?? 'shell', startedAt: new Date().toISOString(), maxOutputChars: options?.maxOutputChars ?? 500_000, outputBuffer: [], outputBufferLength: 0, viewers: new Set(), status: 'running' };
	persistentSessions.set(sessionId, session);
	process.onData((data) => {
		session.outputBuffer.push(data);
		session.outputBufferLength += data.length;
		while (session.outputBufferLength > session.maxOutputChars && session.outputBuffer.length > 1) session.outputBufferLength -= session.outputBuffer.shift()!.length;
		for (const viewer of session.viewers) if (viewer.readyState === WebSocket.OPEN) viewer.send(JSON.stringify({ type: 'data', data }));
	});
	process.onExit(({ exitCode, signal }) => {
		session.status = 'exited';
		session.exitCode = exitCode;
		for (const viewer of session.viewers) {
			if (viewer.readyState === WebSocket.OPEN) { viewer.send(JSON.stringify({ type: 'exit', exitCode })); viewer.close(1000, 'Process exited'); }
		}
		session.viewers.clear();
		try { options?.onExit?.({ exitCode, signal, output: session.outputBuffer.join('') }); }
		catch (error) { console.error('Terminal exit callback failed', error); }
		const cleanup = setTimeout(() => { if (persistentSessions.get(sessionId) === session) persistentSessions.delete(sessionId); }, 300_000);
		cleanup.unref();
	});
}
/** Enumerate live processes, not attachment sockets. */
export function listPersistentSessions(kind?: PersistentSessionKind): PersistentSessionInfo[] {
	return [...persistentSessions].filter(([, session]) => session.status === 'running' && (!kind || session.kind === kind)).map(([id, session]) => ({ id, name: session.name, kind: session.kind, startedAt: session.startedAt, status: session.status, exitCode: session.exitCode }));
}
/** Read the authoritative session without creating it. */
export function getPersistentSession(id: string): PersistentSession | undefined { return persistentSessions.get(id); }
/** Explicit cancellation only. Socket closure must never call this function. */
export function deletePersistentSession(id: string): void {
	const session = persistentSessions.get(id);
	if (!session) return;
	try { session.pty.kill(); } catch { /* Already exited. */ }
}
export const killPersistentSession = deletePersistentSession;
/** Validate the session and browser authority before accepting an upgrade. */
export function isTerminalUpgradeAuthorized(request: IncomingMessage): boolean {
	if (!isCookieHeaderAuthenticated(request.headers.cookie)) return false;
	if (!request.headers.origin || !request.headers.host) return false;
	try { return new URL(request.headers.origin).host === request.headers.host; } catch { return false; }
}
/** Reject unauthorized upgrade requests without connecting a PTY. */
function rejectUpgrade(socket: Duplex): void {
	socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}
/** Attach-only transport. Unknown IDs fail closed, including after a server restart. */
export function attachTerminalServer(server: Server): void {
	const wss = new WebSocketServer({ noServer: true, maxPayload: 65_536 });
	server.on('upgrade', (request, socket, head) => {
		const url = new URL(request.url ?? '/', 'http://localhost');
		if (url.pathname !== '/api/terminal') return;
		if (!isTerminalUpgradeAuthorized(request)) { rejectUpgrade(socket); return; }
		wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
	});
	wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
		const id = new URL(request.url ?? '/', 'http://localhost').searchParams.get('sessionId');
		if (!validSessionId(id)) { ws.close(1008, 'Invalid session id'); return; }
		const session = persistentSessions.get(id);
		if (!session) { ws.send(JSON.stringify({ type: 'missing' })); ws.close(1008, 'Session no longer exists'); return; }
		ws.send(JSON.stringify({ type: 'ready', output: session.outputBuffer.join(''), status: session.status }));
		if (session.status === 'exited') { ws.send(JSON.stringify({ type: 'exit', exitCode: session.exitCode ?? 0 })); ws.close(1000, 'Process exited'); return; }
		session.viewers.add(ws);
		ws.on('error', () => ws.close());
		ws.on('message', (raw) => {
			if (!isCookieHeaderAuthenticated(request.headers.cookie)) { ws.close(1008, 'Authentication required'); return; }
			if (session.status !== 'running') return;
			try {
				const message = JSON.parse(raw.toString());
				if (message.type === 'data' && typeof message.data === 'string' && message.data.length <= 16_384) session.pty.write(message.data);
				else if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols > 0 && message.rows > 0 && message.cols <= 1000 && message.rows <= 1000) session.pty.resize(message.cols, message.rows);
				else ws.close(1008, 'Invalid terminal message');
			} catch { ws.close(1008, 'Invalid terminal message'); }
		});
		ws.on('close', () => session.viewers.delete(ws));
	});
}
