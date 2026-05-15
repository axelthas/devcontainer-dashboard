import * as pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/bootstrap_workspaces';

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
		const command = url.searchParams.get('command') ?? null;
		const cwd = url.searchParams.get('cwd') ?? WORKSPACE_ROOT;

		const shell = process.env.SHELL ?? '/bin/bash';

		const ptyProcess = pty.spawn(shell, [], {
			name: 'xterm-color',
			cols: 80,
			rows: 24,
			cwd,
			env: process.env as Record<string, string>
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
