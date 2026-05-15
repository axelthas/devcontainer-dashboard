<script lang="ts">
	import type { Terminal } from '@xterm/xterm';
	import type { FitAddon } from '@xterm/addon-fit';

	interface Props {
		sessionId: string;
		command?: string;
		cwd?: string;
		active: boolean;
	}

	let { sessionId, command, cwd, active }: Props = $props();

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
				theme: {
					background: '#2e3440',
					foreground: '#d8dee9',
					cursor: '#d8dee9',
					black: '#3b4252',
					red: '#bf616a',
					green: '#a3be8c',
					yellow: '#ebcb8b',
					blue: '#81a1c1',
					magenta: '#b48ead',
					cyan: '#88c0d0',
					white: '#e5e9f0',
					brightBlack: '#4c566a',
					brightRed: '#bf616a',
					brightGreen: '#a3be8c',
					brightYellow: '#ebcb8b',
					brightBlue: '#81a1c1',
					brightMagenta: '#b48ead',
					brightCyan: '#8fbcbb',
					brightWhite: '#eceff4'
				},
				fontFamily: '"Cascadia Code", "Fira Code", monospace',
				fontSize: 13,
				cursorBlink: true,
				scrollback: 5000
			});

			fitAddon = new FitAddon();
			terminal.loadAddon(fitAddon);
			terminal.open(node);
			fitAddon.fit();
			initialized = true;

			const proto = location.protocol === 'https:' ? 'wss' : 'ws';
			const params = new URLSearchParams({ sessionId });
			if (command) params.set('command', command);
			if (cwd) params.set('cwd', cwd);
			const wsUrl = `${proto}://${location.host}/api/terminal?${params}`;

			socket = new WebSocket(wsUrl);

			socket.onmessage = (evt) => {
				try {
					const msg = JSON.parse(evt.data as string);
					if (msg.type === 'data') terminal?.write(msg.data as string);
				} catch {
					terminal?.write(evt.data as string);
				}
			};

			terminal.onData((data) => {
				if (socket?.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({ type: 'data', data }));
				}
			});

			terminal.onResize(({ cols, rows }) => {
				if (socket?.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({ type: 'resize', cols, rows }));
				}
			});
		}

		init();

		return () => {
			destroyed = true;
			socket?.close();
			terminal?.dispose();
		};
	}

	$effect(() => {
		// fitAddon.fit() is a pure DOM resize — does not modify reactive state
		if (active && fitAddon && initialized) {
			setTimeout(() => fitAddon?.fit(), 50);
		}
	});
</script>

<div
	{@attach terminalAttachment}
	class="w-full h-full"
	style="display: {active ? 'block' : 'none'}"
></div>
