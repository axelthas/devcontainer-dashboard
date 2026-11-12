/** Persistent local PTYs. Browser disconnect and explicit process cancellation are distinct. */
import * as pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { IPty } from 'node-pty';
import { isCookieHeaderAuthenticated } from './auth.js';
import { stopTerminalProcess } from './terminalStop.js';
import { appendOutput, terminalLimits } from './terminalPolicy.js';

const CANCEL_SIGNALS = new Set([1, 2, 15]);
const limits = terminalLimits();
export type PersistentSessionKind = 'shell' | 'bootstrap' | 'devcontainer-build';
export interface PersistentSessionExit { exitCode: number; signal?: number; output: string; }
interface PersistentSessionOptions { name?: string; kind?: PersistentSessionKind; maxOutputChars?: number; onExit?: (exit: PersistentSessionExit) => void; }
interface PersistentSession {
	pty: IPty;
	name: string;
	kind: PersistentSessionKind;
	startedAt: string;
	lastActivity: number;
	maxOutputChars: number;
	outputBuffer: string[];
	outputBufferLength: number;
	viewers: Set<WebSocket>;
	status: 'running' | 'exited';
	exitCode?: number;
	stopping?: Promise<void>;
}
export interface PersistentSessionInfo { id: string; name: string; kind: PersistentSessionKind; startedAt: string; status: 'running' | 'exited'; exitCode?: number; }
const globalSessions = globalThis as typeof globalThis & { __terminalSessions?: Map<string, PersistentSession> };
const persistentSessions = (globalSessions.__terminalSessions ??= new Map());
let shuttingDown = false;

/** Bounded URL-safe identity, shared by HTTP and WebSocket validation. */
export function validSessionId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value); }
/** Reject malformed kinds rather than silently creating a shell. */
export function validSessionKind(value: unknown): value is PersistentSessionKind { return value === 'shell' || value === 'bootstrap' || value === 'devcontainer-build'; }
/** Classify deliberate process cancellation separately from command failure. */
export function isCancelledExit(exitCode: number, signal?: number): boolean { return (signal !== undefined && CANCEL_SIGNALS.has(signal)) || CANCEL_SIGNALS.has(exitCode - 128); }
/** Remove dashboard credentials and editor launch hooks from child environments. */
function buildFilteredEnv(): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || key.startsWith('VSCODE_') || ['DASHBOARD_PASSWORD', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'GIT_ASKPASS', 'BROWSER'].includes(key)) continue;
		result[key] = value;
	}
	return { ...result, TERM: 'xterm-256color' };
}
/** Bound total replay memory without terminating running work. Oldest session output is evicted first. */
function enforceGlobalOutput(): void {
	let excess = [...persistentSessions.values()].reduce((sum, session) => sum + session.outputBufferLength, 0) - limits.totalOutput;
	for (const session of persistentSessions.values()) {
		if (excess <= 0) break;
		const remove = Math.min(excess, session.outputBufferLength);
		session.outputBufferLength = appendOutput(session.outputBuffer, '', session.outputBufferLength - remove);
		excess -= remove;
	}
}
/** Create once for an explicit start. Reusing an existing ID never reruns its command. */
export function createPersistentSession(id: string, command: string | undefined, cwd: string, options?: PersistentSessionOptions): void {
	if (!validSessionId(id) || (options?.kind !== undefined && !validSessionKind(options.kind))) throw new Error('Invalid terminal identity');
	if (persistentSessions.has(id)) return;
	if (shuttingDown || persistentSessions.size >= limits.sessions) throw new Error('Terminal session capacity reached');
	const maxOutputChars = options?.maxOutputChars ?? limits.output;
	if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1 || maxOutputChars > 10_000_000) throw new Error('Invalid terminal output limit');
	const child = command ? pty.spawn('/bin/bash', ['-c', command], { name: 'xterm-256color', cols: 120, rows: 30, cwd, env: buildFilteredEnv() }) : pty.spawn(process.env.SHELL ?? '/bin/bash', [], { name: 'xterm-256color', cols: 120, rows: 30, cwd, env: buildFilteredEnv() });
	const session: PersistentSession = { pty: child, name: options?.name ?? 'Shell', kind: options?.kind ?? 'shell', startedAt: new Date().toISOString(), lastActivity: Date.now(), maxOutputChars, outputBuffer: [], outputBufferLength: 0, viewers: new Set(), status: 'running' };
	persistentSessions.set(id, session);
	const lifetime = setInterval(() => {
		const now = Date.now();
		if ((limits.lifetimeMs && now - Date.parse(session.startedAt) >= limits.lifetimeMs) || (limits.idleMs && session.viewers.size === 0 && now - session.lastActivity >= limits.idleMs)) void deletePersistentSession(id).catch(() => {});
	}, 1000);
	lifetime.unref();
	child.onData((data) => {
		session.lastActivity = Date.now();
		session.outputBufferLength = appendOutput(session.outputBuffer, data, session.maxOutputChars);
		enforceGlobalOutput();
		for (const viewer of session.viewers) {
			if (viewer.bufferedAmount > 1_000_000) { viewer.close(1013, 'Viewer cannot keep up; reconnect'); continue; }
			if (viewer.readyState === WebSocket.OPEN) viewer.send(JSON.stringify({ type: 'data', data }));
		}
	});
	child.onExit(({ exitCode, signal }) => {
		clearInterval(lifetime);
		session.status = 'exited';
		session.exitCode = exitCode;
		for (const viewer of session.viewers) if (viewer.readyState === WebSocket.OPEN) { viewer.send(JSON.stringify({ type: 'exit', exitCode })); viewer.close(1000, 'Process exited'); }
		session.viewers.clear();
		try { options?.onExit?.({ exitCode, signal, output: session.outputBuffer.join('') }); } catch (error) { console.error('Terminal exit callback failed', error); }
		const cleanup = setTimeout(() => { if (persistentSessions.get(id) === session) persistentSessions.delete(id); }, 300_000);
		cleanup.unref();
	});
}
/** List processes, not viewer connections. */
export function listPersistentSessions(kind?: PersistentSessionKind): PersistentSessionInfo[] {
	return [...persistentSessions].filter(([, session]) => session.status === 'running' && (!kind || session.kind === kind)).map(([id, session]) => ({ id, name: session.name, kind: session.kind, startedAt: session.startedAt, status: session.status, exitCode: session.exitCode }));
}
/** Find a session without creating a process. */
export function getPersistentSession(id: string): PersistentSession | undefined { return persistentSessions.get(id); }
/** Stop and verify the local process tree. Retain the ID as a short-lived exit tombstone. */
export function deletePersistentSession(id: string): Promise<void> {
	const session = persistentSessions.get(id);
	if (!session || session.status === 'exited') return Promise.resolve();
	if (!session.stopping) {
		session.stopping = stopTerminalProcess(session.pty.pid).catch((error) => { session.stopping = undefined; throw error; });
		void session.stopping.catch(() => {});
	}
	return session.stopping;
}
export const killPersistentSession = deletePersistentSession;
/** Prevent new processes and upgrades before shutdown starts collecting work. */
export function beginTerminalShutdown(): void { shuttingDown = true; }
/** Check browser authority and authentication before accepting an upgrade. */
export function isTerminalUpgradeAuthorized(request: IncomingMessage): boolean {
	if (!isCookieHeaderAuthenticated(request.headers.cookie) || !request.headers.origin || !request.headers.host) return false;
	try { return new URL(request.headers.origin).host === request.headers.host; } catch { return false; }
}
/** Reject before any Docker, shell, or PTY operation. */
function rejectUpgrade(socket: Duplex): void { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
/** Attach-only transport; unknown or exited identities never start a command. */
export function attachTerminalServer(server: Server): void {
	const wss = new WebSocketServer({ noServer: true, maxPayload: 65_536 });
	server.on('upgrade', (request, socket, head) => {
		const url = new URL(request.url ?? '/', 'http://localhost');
		if (url.pathname !== '/api/terminal') return;
		if (shuttingDown || !isTerminalUpgradeAuthorized(request)) { rejectUpgrade(socket); return; }
		wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
	});
	wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
		const id = new URL(request.url ?? '/', 'http://localhost').searchParams.get('sessionId');
		if (!validSessionId(id)) { ws.close(1008, 'Invalid session id'); return; }
		const session = persistentSessions.get(id);
		if (!session) { ws.send(JSON.stringify({ type: 'missing' })); ws.close(1008, 'Session no longer exists'); return; }
		if (session.viewers.size >= limits.viewers) { ws.close(1008, 'Terminal viewer capacity reached'); return; }
		ws.send(JSON.stringify({ type: 'ready', output: session.outputBuffer.join(''), status: session.status }));
		if (session.status === 'exited') { ws.send(JSON.stringify({ type: 'exit', exitCode: session.exitCode ?? 0 })); ws.close(1000, 'Process exited'); return; }
		session.viewers.add(ws);
		let alive = true;
		ws.on('pong', () => { alive = true; });
		const heartbeat = setInterval(() => {
			if (!isCookieHeaderAuthenticated(request.headers.cookie, false)) { ws.close(1008, 'Authentication expired. Sign in and retry.'); return; }
			if (!alive) { ws.terminate(); return; }
			alive = false;
			ws.ping();
		}, 5000);
		heartbeat.unref();
		ws.on('error', () => ws.close());
		ws.on('message', (raw) => {
			if (!isCookieHeaderAuthenticated(request.headers.cookie)) { ws.close(1008, 'Authentication required'); return; }
			if (session.status !== 'running' || session.stopping) return;
			try {
				const message = JSON.parse(raw.toString());
				if (message.type === 'data' && typeof message.data === 'string' && message.data.length <= 16_384) { session.lastActivity = Date.now(); session.pty.write(message.data); }
				else if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols > 0 && message.rows > 0 && message.cols <= 1000 && message.rows <= 1000) session.pty.resize(message.cols, message.rows);
				else ws.close(1008, 'Invalid terminal message');
			} catch { ws.close(1008, 'Invalid terminal message'); }
		});
		ws.on('close', () => { clearInterval(heartbeat); session.viewers.delete(ws); });
	});
}
