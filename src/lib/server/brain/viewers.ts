/**
 * Terminal viewers for Brain commands. A viewer receives the retained output, then live
 * output and state changes. It sends operator keystrokes and PTY sizes; the execution
 * module accepts them only while the operator has control. This module has no WebSocket
 * dependency: `brainTerminal.ts` adapts real sockets to `ViewerPeer`.
 */
import type { BrainTerminalMessage, BrainTerminalState } from '../../brainTypes.js';
import type { BrainExecution } from './state.js';
import { brainState } from './state.js';
import {
	BrainExecutionError,
	isActive,
	resizeTerminal,
	terminalState,
	writeOperatorInput
} from './executions.js';

export const VIEWER_LIMITS = {
	/** Viewers of one command */
	perExecution: 8,
	/** Characters of retained output that a new viewer replays */
	replay: 262_144,
	/** Bytes queued for one viewer before it is disconnected */
	backlog: 1_000_000,
	/** Characters in one viewer message */
	message: 16_384
};

/** The part of a WebSocket that a viewer uses. */
export interface ViewerPeer {
	send(message: string): void;
	close(code: number, reason: string): void;
	readonly bufferedAmount: number;
}

export interface ViewerConnection {
	/** Handle one message from the viewer. */
	message(raw: string): Promise<void>;
	/** Stop sending to the viewer. */
	close(): void;
}

/** Send one typed message. */
function send(peer: ViewerPeer, message: BrainTerminalMessage): void {
	peer.send(JSON.stringify(message));
}

/** True when two states show the same thing. */
function sameState(a: BrainTerminalState, b: BrainTerminalState): boolean {
	return a.status === b.status && a.controller === b.controller && a.exitCode === b.exitCode;
}

/** Parse a viewer message: operator input or a PTY size. */
function parseMessage(
	raw: string
): { type: 'data'; data: string } | { type: 'resize'; cols: number; rows: number } | null {
	if (raw.length > VIEWER_LIMITS.message + 64) return null;
	try {
		const message = JSON.parse(raw);
		if (message?.type === 'data' && typeof message.data === 'string') return message;
		if (message?.type === 'resize' && typeof message.cols === 'number' && typeof message.rows === 'number')
			return message;
	} catch {
		// Invalid JSON is rejected below.
	}
	return null;
}

/**
 * Connect one viewer to a command. Returns null when the viewer was refused; the peer is
 * then already closed. A command that has ended replays its output, then closes.
 */
export function connectViewer(executionId: string, peer: ViewerPeer): ViewerConnection | null {
	const execution: BrainExecution | undefined = brainState.executions.get(executionId);
	if (!execution) {
		send(peer, { type: 'missing' });
		peer.close(1008, 'The command is no longer retained');
		return null;
	}
	if (execution.listeners.size >= VIEWER_LIMITS.perExecution) {
		peer.close(1008, 'Terminal viewer capacity reached');
		return null;
	}
	let last = terminalState(execution);
	send(peer, {
		type: 'ready',
		output: execution.output.slice(-VIEWER_LIMITS.replay),
		truncated: execution.outputStart > 0 || execution.output.length > VIEWER_LIMITS.replay,
		state: last
	});
	if (!isActive(execution)) {
		peer.close(1000, 'The command ended');
		return null;
	}
	let open = true;
	const close = () => {
		open = false;
		execution.listeners.delete(listener);
	};
	const listener = (text?: string) => {
		if (!open) return;
		if (peer.bufferedAmount > VIEWER_LIMITS.backlog) {
			close();
			peer.close(1013, 'Viewer cannot keep up; reconnect');
			return;
		}
		if (text) send(peer, { type: 'data', data: text });
		const state = terminalState(execution);
		if (!sameState(state, last)) {
			last = state;
			send(peer, { type: 'state', state });
		}
		// The final status arrives after the stream ends; then the viewer has everything.
		if (!isActive(execution)) {
			close();
			peer.close(1000, 'The command ended');
		}
	};
	execution.listeners.add(listener);
	return {
		async message(raw) {
			if (!open) return;
			const message = parseMessage(raw);
			if (!message) {
				close();
				peer.close(1008, 'Invalid terminal message');
				return;
			}
			try {
				if (message.type === 'data') writeOperatorInput(execution, message.data);
				else await resizeTerminal(execution, message.cols, message.rows);
			} catch (cause) {
				// Report refusals (for example, typing while Brain has control) to this viewer only.
				if (cause instanceof BrainExecutionError) send(peer, { type: 'error', message: cause.message });
				else throw cause;
			}
		},
		close
	};
}
