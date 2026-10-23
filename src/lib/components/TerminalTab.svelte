<script lang="ts">
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import type { Terminal } from '@xterm/xterm';
	import type { FitAddon } from '@xterm/addon-fit';
	import { TERMINAL_FONT_FAMILY, TERMINAL_THEME } from '$lib/terminalTheme';

	interface Props {
		sessionId: string;
		name?: string;
		command?: string;
		cwd?: string;
		/** Session kind for new sessions; only shell sessions are listed in the terminal drawer */
		kind?: 'shell' | 'bootstrap' | 'devcontainer-build';
		active: boolean;
		fontSize?: number;
		onExit?: (exitCode: number) => void;
	}

	let { sessionId, name, command, cwd, kind, active, fontSize = 13, onExit }: Props = $props();

	let terminal: Terminal | null = null;
	let fitAddon: FitAddon | null = null;
	let socket: WebSocket | null = null;
	let initialized = false;

	function terminalAttachment(node: HTMLDivElement) {
		let destroyed = false;

		async function init() {
			const { Terminal: XTerm } = await import('@xterm/xterm');
			const { FitAddon } = await import('@xterm/addon-fit');

			if (destroyed) return;

			terminal = new XTerm({
				theme: TERMINAL_THEME,
				fontFamily: TERMINAL_FONT_FAMILY,
				fontSize,
				cursorBlink: true,
				scrollback: 5000
			});

			fitAddon = new FitAddon();
			terminal.loadAddon(fitAddon);
			terminal.open(node);

			const proto = location.protocol === 'https:' ? 'wss' : 'ws';
			const params = new SvelteURLSearchParams({ sessionId });
			if (name) params.set('name', name);
			if (command) params.set('command', command);
			if (cwd) params.set('cwd', cwd);
			if (kind) params.set('kind', kind);
			const wsUrl = `${proto}://${location.host}/api/terminal?${params}`;

			socket = new WebSocket(wsUrl);

			// Register onResize BEFORE any fit() call so the event is never dropped
			terminal.onResize(({ cols, rows }) => {
				if (socket?.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({ type: 'resize', cols, rows }));
				}
			});

			terminal.onData((data) => {
				if (socket?.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({ type: 'data', data }));
				}
			});

			socket.onopen = () => {
				fitAddon!.fit();
				// Send initial size explicitly in case onResize didn't fire
				const dims = fitAddon!.proposeDimensions();
				if (dims) {
					socket!.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
				}
				initialized = true;
			};

			socket.onmessage = (evt) => {
				try {
					const msg = JSON.parse(evt.data as string);
					if (msg.type === 'data') terminal?.write(msg.data as string);
					else if (msg.type === 'exit') onExit?.(msg.exitCode ?? 0);
				} catch {
					terminal?.write(evt.data as string);
				}
			};
		}

		init();

		return () => {
			destroyed = true;
			socket?.close();
			terminal?.dispose();
		};
	}

	$effect(() => {
		if (active && fitAddon && initialized) {
			// Delay to let CSS transitions finish on initial open
			setTimeout(() => fitAddon?.fit(), 350);
		}
	});

	function resizeObserverAction(node: HTMLDivElement) {
		const ro = new ResizeObserver(() => {
			if (active && fitAddon && initialized) {
				fitAddon.fit();
			}
		});
		ro.observe(node);
		return () => ro.disconnect();
	}
</script>

<div
	{@attach terminalAttachment}
	{@attach resizeObserverAction}
	class="h-full w-full"
	style="display: {active ? 'block' : 'none'}"
></div>
