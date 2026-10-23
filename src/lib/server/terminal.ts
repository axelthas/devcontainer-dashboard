import * as pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { IPty } from 'node-pty';
import { isCookieHeaderAuthenticated } from './auth.js';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';

// Cap buffered scrollback per session so long-lived interactive shells don't leak memory.
const MAX_OUTPUT_BUFFER_CHARS = 500_000;

// Exited sessions stay as tombstones for this long, so a late viewer receives the exit event
// instead of starting a new shell with the same id.
const EXITED_SESSION_RETENTION_MS = 5 * 60_000;

// SIGHUP (terminal closed or process stopped), SIGINT (Ctrl+C), and SIGTERM mean a cancellation.
const CANCEL_SIGNALS = new Set([1, 2, 15]);

/** True when a process ended because the user cancelled it, not because of its own result. */
export function isCancelledExit(exitCode: number, signal?: number): boolean {
	if (signal !== undefined && CANCEL_SIGNALS.has(signal)) return true;
	// Shells report a process that a signal stopped as exit code 128 + signal number.
	return CANCEL_SIGNALS.has(exitCode - 128);
}

export type PersistentSessionKind = 'shell' | 'bootstrap' | 'devcontainer-build';

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

export interface PersistentSessionExit {
	exitCode: number;
	signal?: number;
	/** Buffered output, limited to the session's maxOutputChars */
	output: string;
}

interface PersistentSessionOptions {
	name?: string;
	kind?: PersistentSessionKind;
	/** Output kept for replay and for onExit; defaults to MAX_OUTPUT_BUFFER_CHARS */
	maxOutputChars?: number;
	/** Called once when the process exits */
	onExit?: (exit: PersistentSessionExit) => void;
}

// Use globalThis so that the vite.config.ts plugin import and the Vite SSR API-route
// import share the same Map in dev mode (they are separate module instances).
const g = globalThis as typeof globalThis & {
	__terminalSessions?: Map<string, PersistentSession>;
};
if (!g.__terminalSessions) g.__terminalSessions = new Map();
const persistentSessions = g.__terminalSessions;

function buildFilteredEnv(): Record<string, string> {
	const filteredEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (key.startsWith('VSCODE_')) continue;
		if (key === 'DASHBOARD_PASSWORD') continue;
		if (key === 'TERM_PROGRAM' || key === 'TERM_PROGRAM_VERSION') continue;
		if (key === 'GIT_ASKPASS' || key === 'BROWSER') continue;
		filteredEnv[key] = value;
	}
	filteredEnv['TERM'] = 'xterm-256color';
	return filteredEnv;
}

export function createPersistentSession(
	sessionId: string,
	command: string | undefined,
	cwd: string,
	options?: PersistentSessionOptions
): void {
	if (persistentSessions.has(sessionId)) return;

	// With no command, spawn an interactive login shell; otherwise run the command directly via
	// bash -c so it starts immediately without shell init delays.
	const shell = process.env.SHELL ?? '/bin/bash';
	const ptyProcess = command
		? pty.spawn('/bin/bash', ['-c', command], {
				name: 'xterm-256color',
				cols: 120,
				rows: 30,
				cwd,
				env: buildFilteredEnv()
			})
		: pty.spawn(shell, [], {
				name: 'xterm-256color',
				cols: 120,
				rows: 30,
				cwd,
				env: buildFilteredEnv()
			});

	const session: PersistentSession = {
		pty: ptyProcess,
		name: options?.name ?? 'Shell',
		kind: options?.kind ?? 'shell',
		startedAt: new Date().toISOString(),
		maxOutputChars: options?.maxOutputChars ?? MAX_OUTPUT_BUFFER_CHARS,
		outputBuffer: [],
		outputBufferLength: 0,
		viewers: new Set(),
		status: 'running'
	};
	persistentSessions.set(sessionId, session);

	ptyProcess.onData((data: string) => {
		session.outputBuffer.push(data);
		session.outputBufferLength += data.length;
		while (session.outputBufferLength > session.maxOutputChars && session.outputBuffer.length > 1) {
			const dropped = session.outputBuffer.shift()!;
			session.outputBufferLength -= dropped.length;
		}
		for (const viewer of session.viewers) {
			if (viewer.readyState === WebSocket.OPEN) {
				viewer.send(JSON.stringify({ type: 'data', data }));
			}
		}
	});

	ptyProcess.onExit(({ exitCode, signal }) => {
		session.status = 'exited';
		session.exitCode = exitCode;
		const output = session.outputBuffer.join('');
		// Viewers close their terminal on exit, so the scrollback is no longer needed.
		session.outputBuffer = [];
		session.outputBufferLength = 0;
		for (const viewer of session.viewers) {
			if (viewer.readyState === WebSocket.OPEN) {
				viewer.send(JSON.stringify({ type: 'exit', exitCode: exitCode ?? 0 }));
				viewer.close();
			}
		}
		session.viewers.clear();
		options?.onExit?.({ exitCode: exitCode ?? 0, signal, output });

		const cleanup = setTimeout(() => {
			if (persistentSessions.get(sessionId) === session) persistentSessions.delete(sessionId);
		}, EXITED_SESSION_RETENTION_MS);
		cleanup.unref();
	});
}

/** Lists running sessions. Exited sessions are tombstones and are not listed. */
export function listPersistentSessions(kind?: PersistentSessionKind): PersistentSessionInfo[] {
	const infos: PersistentSessionInfo[] = [];
	for (const [id, session] of persistentSessions) {
		if (session.status !== 'running') continue;
		if (kind && session.kind !== kind) continue;
		infos.push({
			id,
			name: session.name,
			kind: session.kind,
			startedAt: session.startedAt,
			status: session.status,
			exitCode: session.exitCode
		});
	}
	return infos;
}

export function getPersistentSession(sessionId: string): PersistentSession | undefined {
	return persistentSessions.get(sessionId);
}

export function deletePersistentSession(sessionId: string): void {
	const session = persistentSessions.get(sessionId);
	if (!session) return;
	try {
		session.pty.kill();
	} catch {
		// already dead
	}
	persistentSessions.delete(sessionId);
}

export const killPersistentSession = deletePersistentSession;

export function isTerminalUpgradeAuthorized(request: IncomingMessage): boolean {
	if (!isCookieHeaderAuthenticated(request.headers.cookie)) return false;

	const origin = request.headers.origin;
	const host = request.headers.host;
	if (!origin || !host) return false;

	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

function rejectUpgrade(socket: Duplex): void {
	socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
	socket.destroy();
}

export function attachTerminalServer(httpServer: Server): void {
	const wss = new WebSocketServer({ noServer: true });

	httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		const url = new URL(request.url ?? '/', `http://localhost`);
		if (url.pathname !== '/api/terminal') {
			return; // let other handlers (e.g. Vite HMR) deal with their own upgrades
		}
		if (!isTerminalUpgradeAuthorized(request)) {
			rejectUpgrade(socket);
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			wss.emit('connection', ws, request);
		});
	});

	wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
		const url = new URL(request.url ?? '/', `http://localhost`);
		const sessionId = url.searchParams.get('sessionId');
		const command = url.searchParams.get('command') || undefined;
		const cwd = url.searchParams.get('cwd') ?? WORKSPACE_ROOT;
		const name = url.searchParams.get('name') || undefined;
		const kindParam = url.searchParams.get('kind');
		const kind: PersistentSessionKind =
			kindParam === 'bootstrap' || kindParam === 'devcontainer-build' ? kindParam : 'shell';

		if (!sessionId) {
			ws.close();
			return;
		}

		// All terminal sessions are persistent: they keep running in the background once the
		// WebSocket disconnects, and any client can reattach later using the same sessionId.
		if (!persistentSessions.has(sessionId)) {
			createPersistentSession(sessionId, command, cwd, { name, kind });
		}
		const session = persistentSessions.get(sessionId)!;

		// An exited session has nothing to show; tell the client to close its terminal.
		if (session.status === 'exited') {
			ws.send(JSON.stringify({ type: 'exit', exitCode: session.exitCode ?? 0 }));
			ws.close();
			return;
		}

		// Replay buffered output so the viewer sees the full history
		if (session.outputBuffer.length > 0) {
			ws.send(JSON.stringify({ type: 'data', data: session.outputBuffer.join('') }));
		}

		session.viewers.add(ws);

		ws.on('message', (rawMsg: Buffer | string) => {
			try {
				const msg = JSON.parse(rawMsg.toString());
				if (msg.type === 'data') {
					session.pty.write(msg.data);
				} else if (msg.type === 'resize') {
					session.pty.resize(msg.cols, msg.rows);
				}
			} catch {
				// ignore malformed messages
			}
		});

		ws.on('close', () => {
			session.viewers.delete(ws);
			// Do NOT kill the PTY — session continues in the background
		});
	});
}
