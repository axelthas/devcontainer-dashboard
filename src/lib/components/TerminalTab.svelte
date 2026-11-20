<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { TERMINAL_COLORS, TERMINAL_FONT_FAMILY } from '$lib/terminalTheme';
	import { ensureTerminal } from '$lib/terminalCreation';
	import { validTerminalDimensions } from '$lib/terminalSizing';
	import {
		DEFAULT_TERMINAL_ENGINE,
		TERMINAL_ENGINES,
		type TerminalEngineId,
		type TerminalView,
		type TerminalViewIdentity
	} from '$lib/terminalView';
	import { createTerminalView } from '$lib/terminalViews';

	interface Props {
		sessionId: string;
		name?: string;
		command?: string;
		cwd?: string;
		kind?: 'shell' | 'bootstrap' | 'devcontainer-build';
		/** Browser terminal engine. A change replaces only this viewer, never the process. */
		engine?: TerminalEngineId;
		active: boolean;
		visible?: boolean;
		focusOnActivate?: boolean;
		fontSize?: number;
		onExit?: (exitCode: number) => void;
		/** Report the engine, core, and renderer that actually initialized. */
		onIdentity?: (identity: TerminalViewIdentity | undefined) => void;
		/** Offer an explicit switch to xterm.js after the selected engine fails. */
		onUseFallback?: () => void;
	}
	type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'exited';
	let {
		sessionId,
		name,
		command,
		cwd,
		kind,
		engine = DEFAULT_TERMINAL_ENGINE,
		active,
		visible = active,
		focusOnActivate = false,
		fontSize = 13,
		onExit,
		onIdentity,
		onUseFallback
	}: Props = $props();
	let ready = $state(false);
	let state = $state<ConnectionState>('connecting');
	let reason = $state('');
	/** The selected engine failed, as opposed to the connection or the process. */
	let viewFailed = $state(false);
	let view: TerminalView | undefined;
	let socket: WebSocket | undefined;
	let terminalNode: HTMLDivElement | undefined;
	let retry = $state<() => void>(() => {});
	let activationElement: Element | null = null;
	/** Viewers mounted by this tab. Every viewer after the first is an engine switch. */
	let mountedViewers = 0;

	/** Restored viewers attach while hidden, but must not resize a shared PTY until measurable. */
	function canMeasureTerminal() {
		if (!visible || !terminalNode?.isConnected) return false;
		const bounds = terminalNode.getBoundingClientRect();
		return bounds.width > 0 && bounds.height > 0;
	}
	/** Never send invalid or hidden-pane geometry to the attach-only transport. */
	function sendResize(dimensions: unknown) {
		if (
			!canMeasureTerminal() ||
			!validTerminalDimensions(dimensions) ||
			state !== 'connected' ||
			socket?.readyState !== WebSocket.OPEN
		)
			return;
		socket.send(JSON.stringify({ type: 'resize', ...dimensions }));
	}
	/** Fit after layout, then send even unchanged geometry when a new viewer attaches. */
	async function fitVisibleTerminal() {
		if (!ready || !view || !canMeasureTerminal()) return;
		sendResize(await view.fit());
	}
	/** Describe an unknown failure for the status line. */
	function errorText(error: unknown) {
		return error instanceof Error && error.message ? error.message : 'unknown error';
	}

	/** Own every resource for one viewer. Disposing a viewer never stops its PTY. */
	function terminalAttachment(node: HTMLDivElement) {
		// The key block remounts this viewer when the engine changes, so read it once.
		const selectedEngine = untrack(() => engine);
		const engineLabel = TERMINAL_ENGINES[selectedEngine].label;
		const replacement = mountedViewers++ > 0;
		terminalNode = node;
		let disposed = false;
		let generation = 0;
		let retries = 0;
		let preparing = false;
		let processReady = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let connectTimer: ReturnType<typeof setTimeout> | undefined;
		let reportedExit = false;
		const controller = new AbortController();
		const current = (version: number) => !disposed && version === generation;

		/** Stop using a failed viewer. The server process keeps running. */
		function failView(message: string) {
			if (disposed) return;
			generation++;
			clearTimeout(retryTimer);
			clearTimeout(connectTimer);
			socket?.close();
			view?.dispose();
			view = undefined;
			ready = false;
			viewFailed = true;
			state = 'failed';
			reason = message;
			onIdentity?.(undefined);
		}

		/** Attach to an existing process only. This path cannot start a command. */
		async function connect() {
			const version = ++generation;
			clearTimeout(retryTimer);
			clearTimeout(connectTimer);
			socket?.close();
			state = 'connecting';
			try {
				const probe = await fetch(`/api/terminal/sessions?id=${encodeURIComponent(sessionId)}`, {
					signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
				});
				if (!current(version)) return;
				if (!probe.ok) {
					state = 'failed';
					reason =
						probe.status === 401
							? 'Session expired. Sign in, then retry.'
							: probe.status === 404
								? 'Process no longer exists. Start a new terminal explicitly.'
								: 'Could not check terminal. Retry the connection.';
					return;
				}
				const ws = new WebSocket(
					`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal?${new URLSearchParams({ sessionId })}`
				);
				socket = ws;
				connectTimer = setTimeout(() => {
					if (current(version)) ws.close();
				}, 10_000);
				ws.onmessage = (event) => {
					if (!current(version)) return;
					try {
						const message = JSON.parse(event.data);
						if (message.type === 'ready') {
							clearTimeout(connectTimer);
							state = 'connected';
							reason = '';
							retries = 0;
							// Engines apply writes in call order, so the replay follows the reset.
							view?.reset();
							view?.write(message.output ?? '');
							void fitVisibleTerminal();
						} else if (message.type === 'data' && typeof message.data === 'string')
							view?.write(message.data);
						else if (message.type === 'exit') {
							state = 'exited';
							reason = `Process exited (${message.exitCode ?? 0}).`;
							if (!reportedExit) {
								reportedExit = true;
								onExit?.(message.exitCode ?? 0);
							}
						} else if (message.type === 'missing') {
							state = 'failed';
							reason = 'Process no longer exists. Start a new terminal explicitly.';
						}
					} catch {
						state = 'failed';
						reason = 'Invalid terminal response.';
						ws.close(1008);
					}
				};
				ws.onerror = () => {
					if (current(version)) reason = 'Terminal connection failed.';
				};
				ws.onclose = (event) => {
					if (!current(version)) return;
					clearTimeout(connectTimer);
					if (state === 'exited' || state === 'failed') return;
					if (event.code === 1008) {
						state = 'failed';
						reason = event.reason || 'Connection rejected. Sign in and retry.';
						return;
					}
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
			if (retries >= 5) {
				state = 'failed';
				return;
			}
			retryTimer = setTimeout(() => void connect(), Math.min(500 * 2 ** retries++, 8000));
		}
		/** Recover an explicit start separately from attach-only socket recovery. */
		async function prepareConnection() {
			if (disposed || preparing) return;
			preparing = true;
			state = 'connecting';
			reason = '';
			try {
				// An existing session is only probed here; its command is never sent again.
				await ensureTerminal({ id: sessionId, name, command, cwd, kind }, controller.signal);
				if (disposed) return;
				processReady = true;
				await connect();
			} catch (error) {
				if (!disposed) {
					state = 'failed';
					reason = error instanceof Error ? error.message : 'Could not start terminal.';
				}
			} finally {
				preparing = false;
			}
		}
		/** Mount the selected engine's viewer; recovery reuses the same session identity. */
		async function init() {
			viewFailed = false;
			state = 'connecting';
			reason = '';
			try {
				const created = await createTerminalView(selectedEngine, node, {
					fontFamily: TERMINAL_FONT_FAMILY,
					fontSize: untrack(() => fontSize),
					colors: TERMINAL_COLORS,
					scrollback: 5000,
					signal: controller.signal,
					onData: (data) => {
						if (state === 'connected' && active && visible && socket?.readyState === WebSocket.OPEN)
							socket.send(JSON.stringify({ type: 'data', data }));
					},
					onResize: (dimensions) => sendResize(dimensions),
					onError: (error) => failView(`${engineLabel} stopped: ${errorText(error)}`)
				});
				if (disposed) {
					created.dispose();
					return;
				}
				view = created;
				ready = true;
				onIdentity?.(created.identity);
				// After an engine switch, the operator continues to type in the new viewer.
				if (replacement && untrack(() => active && visible)) created.focus();
				await prepareConnection();
			} catch (error) {
				if (!disposed) failView(`${engineLabel} could not start: ${errorText(error)}`);
			}
		}
		retry = () => {
			retries = 0;
			if (!view) void init();
			else if (!processReady) void prepareConnection();
			else void connect();
		};
		void init();
		return () => {
			disposed = true;
			generation++;
			controller.abort();
			clearTimeout(retryTimer);
			clearTimeout(connectTimer);
			socket?.close();
			view?.dispose();
			view = undefined;
			terminalNode = undefined;
			ready = false;
			retry = () => {};
			onIdentity?.(undefined);
		};
	}
	$effect(() => {
		if (active && visible) activationElement = document.activeElement;
	});
	$effect(() => {
		if (!active || !visible || !ready) return;
		let cancelled = false;
		let frame = 0;
		void tick().then(() => {
			if (cancelled) return;
			frame = requestAnimationFrame(() => {
				if (cancelled || !active || !visible) return;
				void fitVisibleTerminal();
				if (
					focusOnActivate &&
					(document.activeElement === activationElement || document.activeElement === document.body)
				)
					view?.focus();
			});
		});
		return () => {
			cancelled = true;
			cancelAnimationFrame(frame);
		};
	});
	function observeSize(node: HTMLDivElement) {
		const observer = new ResizeObserver(() => {
			void fitVisibleTerminal();
		});
		observer.observe(node);
		return () => observer.disconnect();
	}
</script>

<div class="flex h-full w-full flex-col" hidden={!visible}>
	{#if state !== 'connected'}
		<div role="status" class="flex shrink-0 items-center gap-2 px-2 py-1 text-xs text-[#d8dee9]">
			<span>{reason || 'Connecting...'}</span>
			{#if viewFailed && engine !== DEFAULT_TERMINAL_ENGINE && onUseFallback}<button
					type="button"
					onclick={onUseFallback}
					class="font-semibold text-[#88c0d0] underline"
					>Use {TERMINAL_ENGINES[DEFAULT_TERMINAL_ENGINE].label}</button
				>{/if}
			{#if state === 'failed' || state === 'disconnected'}<button
					type="button"
					onclick={retry}
					class="underline">{viewFailed ? 'Retry' : 'Retry connection'}</button
				>{/if}
		</div>
	{/if}
	{#key engine}
		<div
			{@attach terminalAttachment}
			{@attach observeSize}
			data-terminal-engine={engine}
			class="min-h-0 w-full flex-1"
		></div>
	{/key}
</div>
