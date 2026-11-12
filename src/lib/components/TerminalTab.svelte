<script lang="ts">
	import { tick } from 'svelte';
	import type { Terminal } from '@xterm/xterm';
	import type { FitAddon } from '@xterm/addon-fit';
	import { TERMINAL_FONT_FAMILY, TERMINAL_THEME } from '$lib/terminalTheme';
	import { ensureTerminal } from '$lib/terminalCreation';

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
	type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'exited';
	let { sessionId, name, command, cwd, kind, active, visible = active, focusOnActivate = false, fontSize = 13, onExit }: Props = $props();
	let ready = $state(false);
	let state = $state<ConnectionState>('connecting');
	let reason = $state('');
	let terminal: Terminal | undefined;
	let fitAddon: FitAddon | undefined;
	let socket: WebSocket | undefined;
	let retry = () => {};

	/** Own every resource for one viewer. Disposing a viewer never stops its PTY. */
	function terminalAttachment(node: HTMLDivElement) {
		let disposed = false;
		let generation = 0;
		let retries = 0;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let connectTimer: ReturnType<typeof setTimeout> | undefined;
		let reportedExit = false;
		const controller = new AbortController();
		const subscriptions: { dispose(): void }[] = [];
		const current = (version: number) => !disposed && version === generation;

		/** Attach to an existing process only. This path cannot start a command. */
		async function connect() {
			const version = ++generation;
			clearTimeout(retryTimer);
			clearTimeout(connectTimer);
			socket?.close();
			state = 'connecting';
			try {
				const probe = await fetch(`/api/terminal/sessions?id=${encodeURIComponent(sessionId)}`, { signal: controller.signal });
				if (!current(version)) return;
				if (!probe.ok) {
					state = 'failed';
					reason = probe.status === 401 ? 'Session expired. Sign in, then retry.' : probe.status === 404 ? 'Process no longer exists. Start a new terminal explicitly.' : 'Could not check terminal. Retry the connection.';
					return;
				}
				const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal?${new URLSearchParams({ sessionId })}`);
				socket = ws;
				connectTimer = setTimeout(() => { if (current(version)) ws.close(); }, 10_000);
				ws.onmessage = (event) => {
					if (!current(version)) return;
					try {
						const message = JSON.parse(event.data);
						if (message.type === 'ready') {
							clearTimeout(connectTimer);
							state = 'connected';
							reason = '';
							retries = 0;
							terminal?.reset();
							terminal?.write(message.output ?? '');
							if (visible) fitAddon?.fit();
							const dims = fitAddon?.proposeDimensions();
							if (dims) ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
						} else if (message.type === 'data' && typeof message.data === 'string') terminal?.write(message.data);
						else if (message.type === 'exit') {
							state = 'exited';
							reason = `Process exited (${message.exitCode ?? 0}).`;
							if (!reportedExit) { reportedExit = true; onExit?.(message.exitCode ?? 0); }
						} else if (message.type === 'missing') { state = 'failed'; reason = 'Process no longer exists. Start a new terminal explicitly.'; }
					} catch { state = 'failed'; reason = 'Invalid terminal response.'; ws.close(1008); }
				};
				ws.onerror = () => { if (current(version)) reason = 'Terminal connection failed.'; };
				ws.onclose = (event) => {
					if (!current(version)) return;
					clearTimeout(connectTimer);
					if (state === 'exited' || state === 'failed') return;
					if (event.code === 1008) { state = 'failed'; reason = event.reason || 'Connection rejected. Sign in and retry.'; return; }
					scheduleReconnect();
				};
			} catch {
				if (current(version)) scheduleReconnect();
			}
		}
		/** Bound automatic recovery. Manual retry still attaches, never recreates. */
		function scheduleReconnect() {
			state = 'disconnected';
			reason = 'Disconnected. The process can continue in the background.';
			if (retries >= 5) { state = 'failed'; return; }
			retryTimer = setTimeout(() => void connect(), Math.min(500 * 2 ** retries++, 8000));
		}
		async function init() {
			try {
				const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
				if (disposed) return;
				terminal = new XTerm({ theme: TERMINAL_THEME, fontFamily: TERMINAL_FONT_FAMILY, fontSize, cursorBlink: true, scrollback: 5000 });
				fitAddon = new FitAddon();
				terminal.loadAddon(fitAddon);
				terminal.open(node);
				ready = true;
				subscriptions.push(terminal.onResize(({ cols, rows }) => { if (state === 'connected' && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows })); }));
				subscriptions.push(terminal.onData((data) => { if (state === 'connected' && active && visible && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'data', data })); }));
				await ensureTerminal({ id: sessionId, name, command, cwd, kind }, controller.signal);
				if (!disposed) await connect();
			} catch (error) {
				if (!disposed) { state = 'failed'; reason = error instanceof Error ? error.message : 'Could not initialize terminal.'; }
			}
		}
		retry = () => { retries = 0; void connect(); };
		void init();
		return () => {
			disposed = true;
			generation++;
			controller.abort();
			clearTimeout(retryTimer);
			clearTimeout(connectTimer);
			socket?.close();
			for (const subscription of subscriptions) subscription.dispose();
			terminal?.dispose();
			terminal = undefined;
			fitAddon = undefined;
			ready = false;
			retry = () => {};
		};
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

<div class="flex h-full w-full flex-col" hidden={!visible}>
	{#if state !== 'connected'}
		<div role="status" class="flex shrink-0 items-center gap-2 px-2 py-1 text-xs text-[#d8dee9]">
			<span>{reason || 'Connecting...'}</span>
			{#if state === 'failed' || state === 'disconnected'}<button type="button" onclick={retry} class="underline">Retry connection</button>{/if}
		</div>
	{/if}
	<div {@attach terminalAttachment} {@attach observeSize} class="min-h-0 w-full flex-1"></div>
</div>
