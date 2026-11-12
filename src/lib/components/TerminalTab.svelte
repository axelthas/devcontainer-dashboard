<script lang="ts">
	import { tick } from 'svelte';
	import type { Terminal } from '@xterm/xterm';
	import type { FitAddon } from '@xterm/addon-fit';
	import { TERMINAL_FONT_FAMILY, TERMINAL_THEME } from '$lib/terminalTheme';

	interface Props {
		sessionId: string;
		name?: string;
		command?: string;
		cwd?: string;
		kind?: 'shell' | 'bootstrap' | 'devcontainer-build';
		active: boolean;
		visible?: boolean;
		focusOnActivate?: boolean;
		fontSize?: number;
		onExit?: (exitCode: number) => void;
	}
	let { sessionId, name, command, cwd, kind, active, visible = active, focusOnActivate = false, fontSize = 13, onExit }: Props = $props();
	let ready = $state(false);
	let terminal: Terminal | undefined;
	let fitAddon: FitAddon | undefined;
	let socket: WebSocket | undefined;

	function terminalAttachment(node: HTMLDivElement) {
		let destroyed = false;
		async function init() {
			const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
			if (destroyed) return;
			terminal = new XTerm({ theme: TERMINAL_THEME, fontFamily: TERMINAL_FONT_FAMILY, fontSize, cursorBlink: true, scrollback: 5000 });
			fitAddon = new FitAddon();
			terminal.loadAddon(fitAddon);
			terminal.open(node);
			const params = new URLSearchParams({ sessionId });
			if (name) params.set('name', name);
			if (command) params.set('command', command);
			if (cwd) params.set('cwd', cwd);
			if (kind) params.set('kind', kind);
			socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal?${params}`);
			terminal.onResize(({ cols, rows }) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows })); });
			terminal.onData((data) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'data', data })); });
			socket.onopen = () => { if (!destroyed) ready = true; };
			socket.onmessage = (event) => {
				if (destroyed) return;
				try {
					const message = JSON.parse(event.data);
					if (message.type === 'data') terminal?.write(message.data);
					if (message.type === 'exit') onExit?.(message.exitCode ?? 0);
				} catch { /* Ignore malformed server messages. */ }
			};
		}
		void init();
		return () => { destroyed = true; ready = false; socket?.close(); terminal?.dispose(); terminal = undefined; fitAddon = undefined; };
	}
	$effect(() => {
		if (!active || !visible || !ready) return;
		let cancelled = false;
		let frame = 0;
		void tick().then(() => {
			if (cancelled) return;
			frame = requestAnimationFrame(() => {
				if (cancelled || !active || !visible) return;
				fitAddon?.fit();
				if (focusOnActivate) terminal?.focus();
			});
		});
		return () => { cancelled = true; cancelAnimationFrame(frame); };
	});
	function observeSize(node: HTMLDivElement) {
		const observer = new ResizeObserver(() => { if (visible && ready) fitAddon?.fit(); });
		observer.observe(node);
		return () => observer.disconnect();
	}
</script>

<div {@attach terminalAttachment} {@attach observeSize} class="h-full w-full" hidden={!visible}></div>
