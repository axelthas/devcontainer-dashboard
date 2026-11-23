<script lang="ts">
	/**
	 * One terminal, full screen. The screen follows the visual viewport, so the key bar
	 * stays above the on-screen keyboard. Text size changes with A-/A+ or a pinch; the
	 * viewer refits and the PTY gets the new grid. Leaving the screen never ends the process.
	 */
	import { Check, Keyboard, SquareTerminal, X } from 'lucide-svelte';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';
	import { controlCharacter, TERMINAL_KEYS } from '$lib/mobile/terminalKeys';
	import {
		DEFAULT_TEXT_SIZE,
		MAX_TEXT_SIZE,
		MIN_TEXT_SIZE,
		parseTextSize,
		pinchTextSize,
		stepTextSize,
		TEXT_SIZE_KEY
	} from '$lib/mobile/terminalTextSize';
	import { errorMessage } from '$lib/requests';
	import {
		preferredTerminalEngine,
		rememberTerminalEngine
	} from '$lib/terminalEnginePreference.svelte';
	import { TERMINAL_ENGINE_IDS, TERMINAL_ENGINES, type TerminalEngineId } from '$lib/terminalView';
	import { visualViewportState } from '$lib/visualViewport.svelte';
	import TerminalTab from '$lib/components/TerminalTab.svelte';
	import MConfirm from '$lib/components/mobile/MConfirm.svelte';
	import MGroup from '$lib/components/mobile/MGroup.svelte';
	import MIconButton from '$lib/components/mobile/MIconButton.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';
	import MRow from '$lib/components/mobile/MRow.svelte';
	import MSheet from '$lib/components/mobile/MSheet.svelte';

	const dashboard = useMobileDashboard();
	const id = $derived(page.params.id ?? '');
	/** An explicit start from this phone; without one, the screen only attaches. */
	const start = $derived(dashboard.starts.get(id));
	const session = $derived(dashboard.sessions.find((candidate) => candidate.id === id));
	const name = $derived(start?.name ?? session?.name ?? 'Terminal');
	const cwd = $derived(start?.cwd ?? session?.cwd ?? '');

	let tab: TerminalTab | undefined = $state();
	let connection = $state('connecting');
	let grid = $state<{ cols: number; rows: number } | null>(null);
	let engine = $state<TerminalEngineId>(untrack(() => preferredTerminalEngine()));
	let fontSize = $state(DEFAULT_TEXT_SIZE);
	let zoomOpen = $state(false);
	let ctrlArmed = $state(false);
	let sheet = $state<'menu' | 'end' | null>(null);
	let ending = $state(false);
	let endError = $state('');
	const keyboardOpen = $derived(visualViewportState.keyboardOpen);

	// Each phone keeps its own text size; read it after hydration.
	$effect(() => {
		try {
			fontSize = parseTextSize(localStorage.getItem(TEXT_SIZE_KEY));
		} catch {
			fontSize = DEFAULT_TEXT_SIZE;
		}
	});

	/** Apply and remember a size. */
	function setSize(size: number) {
		fontSize = size;
		try {
			localStorage.setItem(TEXT_SIZE_KEY, String(size));
		} catch {
			// The size still applies to this page.
		}
	}

	/** Send a key-bar key through the terminal input path; Ctrl applies to the next key. */
	function sendKey(data: string) {
		const armed = ctrlArmed && data.length === 1 ? controlCharacter(data) : null;
		ctrlArmed = false;
		if (!tab?.sendInput(armed ?? data)) dashboard.toast('Not connected. The key was not sent.');
	}

	/**
	 * With Ctrl armed, turn the next typed letter into its control character before the
	 * viewer sees it. Capture phase, so this runs before the engine's own key handler.
	 */
	function armedKeydown(event: KeyboardEvent) {
		if (!ctrlArmed || event.ctrlKey || event.metaKey) return;
		const control = controlCharacter(event.key);
		if (!control) return;
		event.preventDefault();
		event.stopPropagation();
		ctrlArmed = false;
		tab?.sendInput(control);
	}

	/** Open or close the on-screen keyboard by moving focus into or out of the viewer. */
	function toggleKeyboard() {
		if (keyboardOpen) (document.activeElement as HTMLElement | null)?.blur();
		else tab?.focus();
	}

	// Pinch: two fingers scale the text size from the size at the start of the gesture.
	let pinch: { distance: number; size: number } | null = null;
	let pinchFrame = 0;
	function distance(touches: TouchList): number {
		const [a, b] = [touches[0], touches[1]];
		return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
	}
	function pinchGesture(node: HTMLElement) {
		const onStart = (event: TouchEvent) => {
			if (event.touches.length !== 2) return;
			pinch = { distance: distance(event.touches), size: fontSize };
		};
		const onMove = (event: TouchEvent) => {
			if (!pinch || event.touches.length !== 2) return;
			event.preventDefault();
			const next = pinchTextSize(pinch.size, pinch.distance, distance(event.touches));
			cancelAnimationFrame(pinchFrame);
			pinchFrame = requestAnimationFrame(() => {
				if (next !== fontSize) {
					fontSize = next;
					zoomOpen = true;
				}
			});
		};
		const onEnd = (event: TouchEvent) => {
			if (!pinch || event.touches.length >= 2) return;
			pinch = null;
			setSize(fontSize);
		};
		node.addEventListener('touchstart', onStart, { passive: true, capture: true });
		node.addEventListener('touchmove', onMove, { passive: false, capture: true });
		node.addEventListener('touchend', onEnd, { capture: true });
		node.addEventListener('touchcancel', onEnd, { capture: true });
		return () => {
			cancelAnimationFrame(pinchFrame);
			node.removeEventListener('touchstart', onStart, { capture: true });
			node.removeEventListener('touchmove', onMove, { capture: true });
			node.removeEventListener('touchend', onEnd, { capture: true });
			node.removeEventListener('touchcancel', onEnd, { capture: true });
		};
	}

	function chooseEngine(next: TerminalEngineId) {
		engine = next;
		rememberTerminalEngine(next);
		sheet = null;
	}

	/** End the process after the confirmation, then return to the list. */
	async function endSession() {
		ending = true;
		endError = '';
		try {
			await dashboard.endTerminal(id);
			sheet = null;
			dashboard.toast('Session ended');
			await goto(resolve('/mobile/terminals'));
		} catch (cause) {
			endError = errorMessage(cause);
		} finally {
			ending = false;
		}
	}
</script>

<div
	class="fixed inset-x-0 flex flex-col bg-m-term text-[#eceff4]"
	style:top="var(--visual-viewport-top, 0px)"
	style:height="var(--visual-viewport-height, 100dvh)"
	data-testid="terminal-screen"
>
	<MNavBar back={{ href: resolve('/mobile/terminals'), label: 'Terminals' }}>
		{#snippet right()}
			<button
				type="button"
				aria-label="Text size"
				aria-pressed={zoomOpen}
				onclick={() => (zoomOpen = !zoomOpen)}
				class="flex size-11 items-center justify-center rounded-full text-[17px] font-semibold {zoomOpen
					? 'bg-m-raised text-m-ink'
					: 'text-m-frost'}"
				data-testid="text-size-toggle">Aa</button
			>
			<MIconButton
				label="Session actions"
				onclick={() => (sheet = 'menu')}
				testid="session-actions"
			/>
		{/snippet}
	</MNavBar>
	<div class="bg-m-screen px-4 pb-2">
		<div class="truncate text-[17px] font-semibold text-m-ink" data-testid="terminal-name">
			{name}
		</div>
		{#if cwd}<div class="truncate font-mono text-[13px] text-m-dim">{cwd}</div>{/if}
	</div>

	{#if zoomOpen}
		<div
			class="flex animate-[m-fade-up_200ms_ease-out] items-center gap-2 bg-m-screen px-3 pb-2"
			role="group"
			aria-label="Text size"
			data-testid="text-size-bar"
		>
			<button
				type="button"
				aria-label="Smaller text"
				onclick={() => setSize(stepTextSize(fontSize, -1))}
				disabled={fontSize <= MIN_TEXT_SIZE}
				class="flex size-11 items-center justify-center rounded-[10px] bg-m-raised text-[15px] font-semibold text-m-ink disabled:opacity-40"
				data-testid="text-smaller">A−</button
			>
			<div class="min-w-0 flex-1 text-center" aria-live="polite">
				<div
					class="text-[16px] font-semibold text-m-ink tabular-nums"
					data-testid="text-size-value"
				>
					{fontSize} pt
				</div>
				<div class="font-mono text-[13px] text-m-dim tabular-nums" data-testid="terminal-grid">
					{grid ? `${grid.cols} × ${grid.rows}` : '…'}
				</div>
			</div>
			<button
				type="button"
				aria-label="Larger text"
				onclick={() => setSize(stepTextSize(fontSize, 1))}
				disabled={fontSize >= MAX_TEXT_SIZE}
				class="flex size-11 items-center justify-center rounded-[10px] bg-m-raised text-[19px] font-semibold text-m-ink disabled:opacity-40"
				data-testid="text-larger">A+</button
			>
			<button
				type="button"
				onclick={() => setSize(stepTextSize(fontSize, 0))}
				class="min-h-11 rounded-[10px] px-3 text-[15px] text-m-frost">Reset</button
			>
		</div>
	{/if}

	<!-- Pinch and the armed Ctrl key are handled in the capture phase, before the viewer. -->
	<div
		class="min-h-0 flex-1 touch-pan-y overflow-hidden px-1 pt-1"
		{@attach pinchGesture}
		onkeydowncapture={armedKeydown}
		data-testid="terminal-host"
	>
		{#key id}
			<TerminalTab
				bind:this={tab}
				sessionId={id}
				name={start?.name}
				command={start?.command}
				cwd={start?.cwd}
				kind={start?.kind}
				{engine}
				{fontSize}
				active={true}
				onConnection={(state) => (connection = state)}
				onGrid={(next) => (grid = next)}
				onUseFallback={() => chooseEngine('xterm')}
				onExit={() => void dashboard.refreshSessions()}
			/>
		{/key}
	</div>

	<div
		role="toolbar"
		aria-label="Terminal keys"
		class="flex shrink-0 [scrollbar-width:none] gap-1.5 overflow-x-auto border-t border-m-edge/60 bg-m-surface px-2 py-1.5"
		style:padding-bottom={keyboardOpen ? '6px' : 'max(6px, env(safe-area-inset-bottom))'}
		data-testid="key-bar"
	>
		<button
			type="button"
			aria-label="Control, applies to the next key"
			aria-pressed={ctrlArmed}
			onclick={() => (ctrlArmed = !ctrlArmed)}
			disabled={connection !== 'connected'}
			class="h-11 min-w-11 shrink-0 rounded-[9px] px-2.5 font-mono text-[15px] disabled:opacity-40 {ctrlArmed
				? 'bg-m-frost text-m-on-frost'
				: 'bg-m-raised text-m-ink'}">Ctrl</button
		>
		{#each TERMINAL_KEYS as key (key.label)}
			<button
				type="button"
				aria-label={key.name}
				onclick={() => sendKey(key.data)}
				disabled={connection !== 'connected'}
				class="h-11 min-w-11 shrink-0 rounded-[9px] px-2.5 font-mono text-[15px] disabled:opacity-40 {key.tone ===
				'signal'
					? 'bg-m-stop/20 text-m-stop'
					: 'bg-m-raised text-m-ink'}">{key.label}</button
			>
		{/each}
		<button
			type="button"
			aria-label={keyboardOpen ? 'Hide keyboard' : 'Show keyboard'}
			onclick={toggleKeyboard}
			class="sticky right-0 ml-auto flex h-11 min-w-11 shrink-0 items-center justify-center rounded-[9px] bg-m-frost/20 text-m-frost backdrop-blur"
			data-testid="keyboard-toggle"><Keyboard size={20} /></button
		>
	</div>
</div>

<MSheet
	open={sheet === 'menu'}
	title="Session"
	onClose={() => (sheet = null)}
	testid="session-sheet"
>
	<MGroup>
		<MRow
			title="Text size"
			subtitle={`${fontSize} pt. Pinch the terminal, or tap Aa. Remembered on this phone.`}
			onclick={() => {
				sheet = null;
				zoomOpen = true;
			}}
		>
			{#snippet icon()}<span class="text-[15px] font-semibold">Aa</span>{/snippet}
		</MRow>
	</MGroup>
	<MGroup title="Engine" footer="Changing the engine replaces only this viewer, never the process.">
		{#each TERMINAL_ENGINE_IDS as option (option)}
			<MRow
				title={TERMINAL_ENGINES[option].label}
				subtitle={TERMINAL_ENGINES[option].hint}
				onclick={() => chooseEngine(option)}
			>
				{#snippet icon()}<SquareTerminal size={18} />{/snippet}
				{#snippet trailing()}{#if option === engine}<Check
							size={20}
							class="shrink-0 text-m-frost"
						/>{/if}{/snippet}
			</MRow>
		{/each}
	</MGroup>
	<MGroup footer="Leaving this screen never stops the session. Only this does.">
		<MRow
			title="End session…"
			danger
			tone="bg-m-stop/15 text-m-stop"
			onclick={() => (sheet = 'end')}
			chevron
			testid="end-session"
		>
			{#snippet icon()}<X size={18} />{/snippet}
		</MRow>
	</MGroup>
</MSheet>

<MSheet open={sheet === 'end'} title="End session" onClose={() => (sheet = null)}>
	<MConfirm
		title={`End ${name}?`}
		body="The shell and every job that runs in it stop. Unsaved work in editors that run in it is lost."
		action="End session"
		busy={ending}
		error={endError}
		onConfirm={() => void endSession()}
		onCancel={() => (sheet = null)}
	/>
</MSheet>
