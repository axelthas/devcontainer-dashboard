import * as pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { IPty } from 'node-pty';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';

interface PersistentSession {
	pty: IPty;
	outputBuffer: string[];
	viewers: Set<WebSocket>;
	status: 'running' | 'exited';
	exitCode?: number;
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
		if (key === 'TERM_PROGRAM' || key === 'TERM_PROGRAM_VERSION') continue;
		if (key === 'GIT_ASKPASS' || key === 'BROWSER') continue;
		filteredEnv[key] = value;
	}
	filteredEnv['TERM'] = 'xterm-256color';
	return filteredEnv;
}

export function createPersistentSession(sessionId: string, command: string, cwd: string): void {
	if (persistentSessions.has(sessionId)) return;

	// Spawn the command directly via bash -c so it runs immediately without shell init delays
	const ptyProcess = pty.spawn('/bin/bash', ['-c', command], {
		name: 'xterm-256color',
		cols: 120,
		rows: 30,
		cwd,
		env: buildFilteredEnv()
	});

	const session: PersistentSession = {
		pty: ptyProcess,
		outputBuffer: [],
		viewers: new Set(),
		status: 'running'
	};
	persistentSessions.set(sessionId, session);

	ptyProcess.onData((data: string) => {
		session.outputBuffer.push(data);
		for (const viewer of session.viewers) {
			if (viewer.readyState === WebSocket.OPEN) {
				viewer.send(JSON.stringify({ type: 'data', data }));
			}
		}
	});

	ptyProcess.onExit(({ exitCode }) => {
		session.status = 'exited';
		session.exitCode = exitCode;
		for (const viewer of session.viewers) {
			if (viewer.readyState === WebSocket.OPEN) {
				viewer.send(JSON.stringify({ type: 'exit' }));
				viewer.close();
			}
		}
		session.viewers.clear();
	});
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

export function attachTerminalServer(httpServer: Server): void {
	const wss = new WebSocketServer({ noServer: true });

	httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		const url = new URL(request.url ?? '/', `http://localhost`);
		if (url.pathname !== '/api/terminal') {
			return; // let other handlers (e.g. Vite HMR) deal with their own upgrades
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			wss.emit('connection', ws, request);
		});
	});

	wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
		const url = new URL(request.url ?? '/', `http://localhost`);
		const sessionId = url.searchParams.get('sessionId') ?? null;
		const command = url.searchParams.get('command') ?? null;
		const cwd = url.searchParams.get('cwd') ?? WORKSPACE_ROOT;

		// Attach to an existing persistent session (background bootstrap run)
		if (sessionId && persistentSessions.has(sessionId)) {
			const session = persistentSessions.get(sessionId)!;

			// Replay buffered output so the viewer sees the full history
			if (session.outputBuffer.length > 0) {
				ws.send(JSON.stringify({ type: 'data', data: session.outputBuffer.join('') }));
			}

			// If already exited, notify immediately
			if (session.status === 'exited') {
				ws.send(JSON.stringify({ type: 'exit' }));
				ws.close();
				return;
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

			return;
		}

		// --- Ephemeral terminal (existing behaviour) ---
		const shell = process.env.SHELL ?? '/bin/bash';

		const ptyProcess = pty.spawn(shell, [], {
			name: 'xterm-256color',
			cols: 80,
			rows: 24,
			cwd,
			env: buildFilteredEnv()
		});

		ptyProcess.onData((data: string) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'data', data }));
			}
		});

		ptyProcess.onExit(() => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'exit' }));
				ws.close();
			}
		});

		if (command) {
			// Small delay to let the shell initialise
			setTimeout(() => {
				ptyProcess.write(command + '\r');
			}, 300);
		}

		ws.on('message', (rawMsg: Buffer | string) => {
			try {
				const msg = JSON.parse(rawMsg.toString());
				if (msg.type === 'data') {
					ptyProcess.write(msg.data);
				} else if (msg.type === 'resize') {
					ptyProcess.resize(msg.cols, msg.rows);
				}
			} catch {
				// ignore malformed messages
			}
		});

		ws.on('close', () => {
			try {
				ptyProcess.kill();
			} catch {
				// already dead
			}
		});
	});
}
