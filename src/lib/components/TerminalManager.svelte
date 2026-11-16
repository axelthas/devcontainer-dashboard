<script lang="ts">
	import { onDestroy } from 'svelte';
	import { X, Plus, Terminal, ChevronDown, ChevronUp, Maximize2, Minimize2 } from 'lucide-svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import TerminalTab from './TerminalTab.svelte';
	import TerminalEngineSelect from './TerminalEngineSelect.svelte';
	import { generateId } from '$lib/index';
	import type { TerminalSession } from '$lib/types';
	import {
		TERMINAL_ENGINES,
		type TerminalEngineId,
		type TerminalViewIdentity
	} from '$lib/terminalView';
	import {
		defaultTerminalEngine,
		setDefaultTerminalEngine
	} from '$lib/terminalEnginePreference.svelte';

	interface TerminalSessionState extends TerminalSession {
		command?: string;
		cwd?: string;
		/** Engine requested when the terminal was opened; the default applies otherwise. */
		engine?: TerminalEngineId;
	}
	interface Props {
		open: boolean;
		sessions: TerminalSessionState[];
		activeId: string | null;
		workspaceRoot: string;
		onToggle: () => void;
		onAddSession: (session: TerminalSessionState) => void;
		onCloseSession: (id: string) => Promise<void>;
		onSetActive: (id: string) => void;
	}
	let {
		open,
		sessions,
		activeId,
		workspaceRoot,
		onToggle,
		onAddSession,
		onCloseSession,
		onSetActive
	}: Props = $props();
	let height = $state(320);
	let maximized = $state(false);
	let dragging = $state(false);
	let closeError = $state('');
	let stopDrag = () => {};
	const closingIds = new SvelteSet<string>();
	/** Engine pinned per terminal, so a later default change never remounts an open terminal. */
	const engines = new SvelteMap<string, TerminalEngineId>();
	/** Engine, core, and renderer that each viewer actually initialized. */
	const identities = new SvelteMap<string, TerminalViewIdentity>();
	const activeSession = $derived(sessions.find((session) => session.id === activeId));
	const activeIdentity = $derived(activeId ? identities.get(activeId) : undefined);

	/** Use the pinned engine, then the requested engine, then the current default. */
	function engineFor(session: TerminalSessionState): TerminalEngineId {
		return engines.get(session.id) ?? session.engine ?? defaultTerminalEngine();
	}
	/** Replace only the active terminal's viewer; its process keeps running. */
	function setActiveEngine(engine: TerminalEngineId) {
		if (activeId) engines.set(activeId, engine);
	}
	/** Track what each viewer reports; a disposed viewer reports undefined. */
	function setIdentity(id: string, identity: TerminalViewIdentity | undefined) {
		if (identity) identities.set(id, identity);
		else identities.delete(id);
	}
	$effect(() => {
		const ids = new Set(sessions.map((session) => session.id));
		for (const session of sessions)
			if (!engines.has(session.id))
				engines.set(session.id, session.engine ?? defaultTerminalEngine());
		for (const id of [...engines.keys()])
			if (!ids.has(id)) {
				engines.delete(id);
				identities.delete(id);
			}
	});

	function addGenericShell() {
		const id = generateId();
		onAddSession({ id, name: 'Shell', cwd: workspaceRoot, engine: defaultTerminalEngine() });
		onSetActive(id);
		if (!open) onToggle();
	}
	async function closeSession(id: string) {
		if (closingIds.has(id)) return;
		closingIds.add(id);
		closeError = '';
		try {
			await onCloseSession(id);
		} catch {
			closeError = 'Could not stop terminal. Retry when the connection is restored.';
		} finally {
			closingIds.delete(id);
		}
	}
	function onResizeStart(event: MouseEvent) {
		if (maximized) return;
		event.preventDefault();
		stopDrag();
		dragging = true;
		const startY = event.clientY;
		const startHeight = height;
		const move = (next: MouseEvent) => {
			height = Math.min(
				Math.max(150, startHeight + startY - next.clientY),
				window.innerHeight - 50
			);
		};
		stopDrag = () => {
			dragging = false;
			window.removeEventListener('mousemove', move);
			window.removeEventListener('mouseup', stopDrag);
		};
		window.addEventListener('mousemove', move);
		window.addEventListener('mouseup', stopDrag);
	}
	onDestroy(() => stopDrag());
</script>

<div
	class="fixed right-0 bottom-0 left-0 z-40 flex flex-col border-t border-[#4c566a] bg-[#2e3440] {dragging
		? ''
		: 'transition-all duration-300'}"
	style:height={open ? (maximized ? '100vh' : `${height}px`) : '2.5rem'}
>
	{#if open && !maximized}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="absolute top-0 right-0 left-0 z-50 h-1.5 cursor-ns-resize"
			onmousedown={onResizeStart}
		></div>
	{/if}
	<div
		class="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-[#4c566a] px-2"
		role="tablist"
		aria-label="Terminals"
	>
		{#each sessions as session (session.id)}
			<div
				class="flex shrink-0 items-center rounded-t {activeId === session.id
					? 'bg-[#3b4252] text-[#eceff4]'
					: 'text-[#d8dee9]/60'}"
			>
				<button
					data-terminal-tab={session.id}
					id={`terminal-tab-${session.id}`}
					role="tab"
					aria-selected={activeId === session.id}
					aria-controls={`terminal-pane-${session.id}`}
					class="flex items-center gap-1.5 px-3 py-1 text-xs font-medium"
					onclick={() => {
						onSetActive(session.id);
						if (!open) onToggle();
					}}
					type="button"
				>
					<Terminal size={12} /><span class="max-w-28 truncate">{session.name}</span>
					<span
						class="rounded bg-[#4c566a]/60 px-1 text-[10px] leading-4 text-[#d8dee9]"
						title={TERMINAL_ENGINES[engineFor(session)].label}
						>{TERMINAL_ENGINES[engineFor(session)].short}</span
					>
				</button>
				<button
					class="pr-2 text-[#d8dee9]/40 disabled:opacity-50"
					onclick={() => closeSession(session.id)}
					disabled={closingIds.has(session.id)}
					type="button"
					aria-label={`Stop ${session.name}`}><X size={11} /></button
				>
			</div>
		{/each}
		<button
			onclick={addGenericShell}
			class="shrink-0 p-1 text-[#d8dee9]/60"
			type="button"
			aria-label="New shell"><Plus size={14} /></button
		>
		<TerminalEngineSelect
			label="New"
			value={defaultTerminalEngine()}
			help="Engine for terminals and OpenCode TUI windows opened from now on."
			onSelect={setDefaultTerminalEngine}
		/>
		<div class="flex-1"></div>
		{#if open && activeSession}
			{#if activeIdentity}
				<span
					class="max-w-56 shrink truncate text-[11px] text-[#d8dee9]/50"
					title={`${activeIdentity.core} · ${activeIdentity.renderer}`}
					>{activeIdentity.core} · {activeIdentity.renderer}</span
				>
			{/if}
			<TerminalEngineSelect
				label="This terminal"
				value={engineFor(activeSession)}
				help="Switch how this terminal is displayed. Its process keeps running."
				onSelect={setActiveEngine}
			/>
		{/if}
		{#if open}
			<button
				onclick={() => (maximized = !maximized)}
				class="p-1 text-[#d8dee9]/60"
				type="button"
				aria-label={maximized ? 'Restore terminal' : 'Maximize terminal'}
				>{#if maximized}<Minimize2 size={14} />{:else}<Maximize2 size={14} />{/if}</button
			>
		{/if}
		<button
			onclick={onToggle}
			class="p-1 text-[#d8dee9]/60"
			type="button"
			aria-label="Toggle terminal drawer"
			aria-expanded={open}
			>{#if open}<ChevronDown size={16} />{:else}<ChevronUp size={16} />{/if}</button
		>
	</div>
	{#if closeError}<p role="alert" class="text-xs text-[#bf616a]">{closeError}</p>{/if}
	<div class="relative min-h-0 flex-1 overflow-hidden" hidden={!open}>
		{#each sessions as session (session.id)}
			<div
				id={`terminal-pane-${session.id}`}
				data-terminal-pane={session.id}
				role="tabpanel"
				aria-labelledby={`terminal-tab-${session.id}`}
				class="absolute inset-2"
				hidden={!open || activeId !== session.id}
				inert={!open || activeId !== session.id}
			>
				<TerminalTab
					sessionId={session.id}
					name={session.name}
					command={session.command}
					cwd={session.cwd ?? workspaceRoot}
					engine={engineFor(session)}
					active={activeId === session.id}
					visible={open && activeId === session.id}
					focusOnActivate={true}
					onExit={() => closeSession(session.id)}
					onIdentity={(identity) => setIdentity(session.id, identity)}
					onUseFallback={() => engines.set(session.id, 'xterm')}
				/>
			</div>
		{/each}
	</div>
</div>
