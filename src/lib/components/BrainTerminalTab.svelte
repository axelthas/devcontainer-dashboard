<script lang="ts">
	/**
	 * One Brain command or persistent shell in the terminal drawer: live output in a
	 * read-only terminal, and explicit control. "Take over" gives terminal input to the
	 * operator and refuses Brain input; "Hand back" returns it. Closing the tab or the socket
	 * never stops the command or shell.
	 */
	import { tick, untrack } from 'svelte';
	import type { Terminal } from '@xterm/xterm';
	import type { FitAddon } from '@xterm/addon-fit';
	import { BrainCircuit, Keyboard, Square, Undo2 } from 'lucide-svelte';
	import { TERMINAL_FONT_FAMILY, TERMINAL_THEME } from '$lib/terminalTheme';
	import { validTerminalDimensions } from '$lib/terminalSizing';
	import { isRunningStatus, type BrainAccess } from '$lib/brainAccess.svelte';
	import type {
		BrainExecutionView,
		BrainTerminalMessage,
		BrainTerminalState
	} from '$lib/brainTypes';
	import { errorMessage } from '$lib/requests';

	interface Props {
		execution: BrainExecutionView;
		access: BrainAccess;
		visible: boolean;
	}
	type Connection = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'ended';

	let { execution, access, visible }: Props = $props();

	const MAX_RETRIES = 5;
	let connection = $state<Connection>('connecting');
	let reason = $state('');
	/** Live state from the socket; newer than the 5 s status poll */
	let live = $state<BrainTerminalState | null>(null);
	let notice = $state('');
	let working = $state(false);
	let ready = $state(false);
	let retry = $state<() => void>(() => {});
	let terminal: Terminal | undefined;
	let fitAddon: FitAddon | undefined;
	let socket: WebSocket | undefined;
	let terminalNode: HTMLDivElement | undefined;

	const status = $derived(live?.status ?? execution.status);
	const controller = $derived(live?.controller ?? execution.controller);
	const exitCode = $derived(live?.exitCode ?? execution.exitCode);
	const running = $derived(isRunningStatus(status));
	const controllable = $derived(status === 'running');
	const operator = $derived(controllable && controller === 'operator');
	const shell = $derived(execution.kind === 'shell' ? execution.shell : undefined);

	/** Final result of a command that ended. */
	function outcome(): string {
		if (status === 'exited') return `Ended · exit ${exitCode ?? '?'}`;
		if (status === 'stopping') return 'Stopping';
		if (status === 'stopped') return 'Stopped';
		if (status === 'stop_unconfirmed') return 'Stop not confirmed';
		return 'Failed';
	}

	/** Send one message when the socket is open. */
	function sendMessage(message: object) {
		if (connection === 'connected' && socket?.readyState === WebSocket.OPEN)
			socket.send(JSON.stringify(message));
	}

	/** Fit the viewer, and give the size to the PTY while the operator has control. */
	function fitTerminal(force = false) {
		if (!ready || !terminal || !visible || !terminalNode?.isConnected) return;
		const bounds = terminalNode.getBoundingClientRect();
		if (bounds.width <= 0 || bounds.height <= 0) return;
		const dimensions = fitAddon?.proposeDimensions();
		if (!validTerminalDimensions(dimensions)) return;
		if (terminal.cols !== dimensions.cols || terminal.rows !== dimensions.rows)
			terminal.resize(dimensions.cols, dimensions.rows);
		else if (force && operator) sendMessage({ type: 'resize', ...dimensions });
	}

	/** Own the xterm viewer and its socket. Disposal never stops the command. */
	function terminalAttachment(node: HTMLDivElement) {
		terminalNode = node;
		// The status poll replaces `execution` every 5 s. Read the ID untracked, so a poll
		// does not recreate the viewer. The drawer keys each tab by this ID.
		const id = untrack(() => execution.id);
		let disposed = false;
		let generation = 0;
		let retries = 0;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		const subscriptions: { dispose(): void }[] = [];
		const current = (version: number) => !disposed && version === generation;

		/** Handle one server message. */
		function receive(message: BrainTerminalMessage) {
			if (message.type === 'ready') {
				connection = 'connected';
				reason = '';
				retries = 0;
				live = message.state;
				terminal?.reset();
				if (message.truncated) terminal?.write('\x1b[2m[Earlier output is not shown]\x1b[0m\n');
				terminal?.write(message.output);
				fitTerminal(true);
			} else if (message.type === 'data') terminal?.write(message.data);
			else if (message.type === 'state') live = message.state;
			else if (message.type === 'error') notice = message.message;
			else if (message.type === 'missing') {
				connection = 'failed';
				reason = 'The command is no longer retained.';
			}
		}

		/** Connect to the command's output. This path cannot start a command. */
		function connect() {
			const version = ++generation;
			clearTimeout(retryTimer);
			socket?.close();
			connection = 'connecting';
			const ws = new WebSocket(
				`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/brain/terminal?${new URLSearchParams({ executionId: id })}`
			);
			socket = ws;
			ws.onmessage = (event) => {
				if (!current(version)) return;
				try {
					receive(JSON.parse(event.data) as BrainTerminalMessage);
				} catch {
					connection = 'failed';
					reason = 'Invalid terminal response.';
					ws.close();
				}
			};
			ws.onclose = (event) => {
				if (!current(version)) return;
				// The server closes after the final status; the output is then complete.
				if (live && !isRunningStatus(live.status)) {
					connection = 'ended';
					return;
				}
				if (connection === 'failed') return;
				if (event.code === 1008) {
					connection = 'failed';
					reason = event.reason || 'Connection rejected. Sign in and retry.';
					return;
				}
				connection = 'disconnected';
				reason = 'Disconnected. The command continues in the container.';
				if (retries >= MAX_RETRIES) {
					connection = 'failed';
					return;
				}
				retryTimer = setTimeout(connect, Math.min(500 * 2 ** retries++, 8000));
			};
		}

		/** Create the viewer: read-only until the operator takes control. */
		async function init() {
			try {
				const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([
					import('@xterm/xterm'),
					import('@xterm/addon-fit')
				]);
				if (disposed) return;
				terminal = new XTerm({
					theme: TERMINAL_THEME,
					fontFamily: TERMINAL_FONT_FAMILY,
					fontSize: 13,
					// Brain output uses LF line endings.
					convertEol: true,
					disableStdin: true,
					cursorBlink: false,
					scrollback: 5000
				});
				fitAddon = new FitAddon();
				terminal.loadAddon(fitAddon);
				terminal.open(node);
				ready = true;
				subscriptions.push(
					terminal.onResize(({ cols, rows }) => {
						if (operator) sendMessage({ type: 'resize', cols, rows });
					}),
					terminal.onData((data) => {
						if (operator) sendMessage({ type: 'data', data });
					})
				);
				connect();
			} catch (cause) {
				if (!disposed) {
					connection = 'failed';
					reason = errorMessage(cause);
				}
			}
		}

		retry = () => {
			retries = 0;
			if (!terminal) void init();
			else connect();
		};
		void init();
		return () => {
			disposed = true;
			generation++;
			clearTimeout(retryTimer);
			socket?.close();
			for (const subscription of subscriptions) subscription.dispose();
			terminal?.dispose();
			terminal = undefined;
			fitAddon = undefined;
			terminalNode = undefined;
			ready = false;
			retry = () => {};
		};
	}

	// Keyboard input follows control. Taking control also gives the PTY this viewer's size.
	$effect(() => {
		const typing = operator;
		if (!ready || !terminal) return;
		terminal.options.disableStdin = !typing;
		terminal.options.cursorBlink = typing;
		if (!typing || !visible) return;
		void tick().then(() => {
			fitTerminal(true);
			terminal?.focus();
		});
	});

	// Fit after the pane becomes visible.
	$effect(() => {
		if (!visible || !ready) return;
		const frame = requestAnimationFrame(() => fitTerminal());
		return () => cancelAnimationFrame(frame);
	});

	function observeSize(node: HTMLDivElement) {
		const observer = new ResizeObserver(() => fitTerminal());
		observer.observe(node);
		return () => observer.disconnect();
	}

	/** Run one control action at a time and show its failure in the tab. */
	async function act(action: () => Promise<void>) {
		if (working) return;
		working = true;
		notice = '';
		try {
			await action();
		} catch (cause) {
			notice = errorMessage(cause);
		} finally {
			working = false;
		}
	}

	function setControl(next: 'operator' | 'brain') {
		void act(async () => {
			await access.setController(execution.id, next);
			// The socket confirms the change; this covers a socket that is reconnecting.
			if (live) live = { ...live, controller: next };
		});
	}
</script>

<div class="flex h-full w-full flex-col gap-1" hidden={!visible}>
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-[#d8dee9]">
		{#if operator}
			<span class="flex items-center gap-1.5 font-semibold text-[#ebcb8b]">
				<Keyboard size={13} />You have control
			</span>
		{:else if controllable}
			<span class="flex items-center gap-1.5 font-semibold text-[#b48ead]">
				<BrainCircuit size={13} />Brain is driving
			</span>
		{:else}
			<span class="flex items-center gap-1.5 font-semibold text-[#d8dee9]/70">
				<BrainCircuit size={13} />{outcome()}
			</span>
		{/if}
		<span class="min-w-0 truncate text-[#d8dee9]/60">
			{#if shell}<span class="font-mono text-[#d8dee9]/80">{shell.name}</span> ·{/if}
			{execution.containerName} · as <span class="font-mono">{execution.user}</span>
			{#if shell?.cwd}in <span class="font-mono">{shell.cwd}</span>
			{:else if execution.workdir}in <span class="font-mono">{execution.workdir}</span>{/if}
		</span>
		<span class="flex-1"></span>
		{#if controllable}
			{#if operator}
				<button
					type="button"
					disabled={working}
					onclick={() => setControl('brain')}
					class="flex items-center gap-1 rounded-lg border border-[#b48ead]/50 px-2 py-0.5 font-medium text-[#b48ead] transition-colors hover:bg-[#b48ead]/15 disabled:opacity-50"
				>
					<Undo2 size={12} />Hand back to Brain
				</button>
			{:else}
				<button
					type="button"
					disabled={working}
					onclick={() => setControl('operator')}
					class="flex items-center gap-1 rounded-lg border border-[#ebcb8b]/50 px-2 py-0.5 font-medium text-[#ebcb8b] transition-colors hover:bg-[#ebcb8b]/15 disabled:opacity-50"
				>
					<Keyboard size={12} />Take over
				</button>
			{/if}
		{/if}
		{#if running}
			<button
				type="button"
				disabled={working || status === 'stopping'}
				onclick={() => void act(() => access.stop(execution.id))}
				class="flex items-center gap-1 rounded-lg px-2 py-0.5 font-medium text-[#bf616a] transition-colors hover:bg-[#bf616a]/15 disabled:opacity-50"
			>
				<Square size={10} />{shell ? 'Close shell' : 'Stop'}
			</button>
		{/if}
	</div>
	{#if !shell}
		<p class="truncate px-1 font-mono text-xs text-[#d8dee9]/80" title={execution.command}>
			<span class="text-[#d8dee9]/40">$</span>
			{execution.command}
		</p>
	{/if}
	{#if operator}
		<p class="px-1 text-xs text-[#ebcb8b]/80">
			Brain cannot type or cancel until you hand back control. Brain can still read everything shown
			here, including what you type.
			{#if !execution.interactive}This command does not read input; Ctrl+C and password prompts
				still reach it.{/if}
		</p>
	{/if}
	{#if notice}<p role="alert" class="px-1 text-xs text-[#bf616a]">{notice}</p>{/if}
	{#if connection !== 'connected' && connection !== 'ended'}
		<div role="status" class="flex items-center gap-2 px-1 text-xs text-[#d8dee9]">
			<span>{reason || 'Connecting...'}</span>
			{#if connection === 'failed' || connection === 'disconnected'}<button
					type="button"
					onclick={retry}
					class="underline">Retry connection</button
				>{/if}
		</div>
	{/if}
	<div
		{@attach terminalAttachment}
		{@attach observeSize}
		aria-label={`Brain terminal: ${execution.command}`}
		class="min-h-0 w-full flex-1 {operator ? 'ring-1 ring-[#ebcb8b]/60' : ''}"
	></div>
	{#if controllable && !operator}
		<p class="px-1 text-xs text-[#d8dee9]/50">Read-only. Take over to type.</p>
	{/if}
</div>
