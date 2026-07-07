<script lang="ts">
	import { X, Plus, Terminal, ChevronDown, ChevronUp, Maximize2, Minimize2 } from 'lucide-svelte';
	import TerminalTab from './TerminalTab.svelte';
	import { generateId } from '$lib/index';
	import type { TerminalSession } from '$lib/types';

	interface TerminalSessionState extends TerminalSession {
		command?: string;
		cwd?: string;
	}

	interface Props {
		open: boolean;
		sessions: TerminalSessionState[];
		activeId: string | null;
		workspaceRoot: string;
		onToggle: () => void;
		onAddSession: (session: TerminalSessionState) => void;
		onRemoveSession: (id: string) => void;
		onSetActive: (id: string) => void;
	}

	let {
		open,
		sessions,
		activeId,
		workspaceRoot,
		onToggle,
		onAddSession,
		onRemoveSession,
		onSetActive
	}: Props = $props();

	let height = $state(320);
	let maximized = $state(false);
	let dragging = $state(false);

	const MIN_HEIGHT = 150;

	function addGenericShell() {
		const id = generateId();
		onAddSession({ id, name: 'Shell', cwd: workspaceRoot });
		onSetActive(id);
		if (!open) onToggle();
	}

	function closeSession(id: string) {
		onRemoveSession(id);
	}

	function toggleMaximize() {
		maximized = !maximized;
	}

	function onResizeStart(e: MouseEvent) {
		if (maximized) return;
		e.preventDefault();
		dragging = true;
		const startY = e.clientY;
		const startHeight = height;

		function onMouseMove(ev: MouseEvent) {
			const delta = startY - ev.clientY;
			const newHeight = Math.max(MIN_HEIGHT, startHeight + delta);
			height = Math.min(newHeight, window.innerHeight - 50);
		}

		function onMouseUp() {
			dragging = false;
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseup', onMouseUp);
		}

		window.addEventListener('mousemove', onMouseMove);
		window.addEventListener('mouseup', onMouseUp);
	}
</script>

<!-- Terminal drawer — fixed bottom -->
<div
	class="fixed right-0 bottom-0 left-0 z-40 flex flex-col border-t border-[#4c566a] bg-[#2e3440] {dragging
		? ''
		: 'transition-all duration-300'}"
	style="height: {open ? (maximized ? '100vh' : `${height}px`) : '2.5rem'}"
>
	<!-- Resize handle -->
	{#if open && !maximized}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="absolute top-0 right-0 left-0 z-50 h-1.5 cursor-ns-resize hover:bg-[#88c0d0]/30 active:bg-[#88c0d0]/50"
			onmousedown={onResizeStart}
		></div>
	{/if}

	<!-- Tab bar -->
	<div class="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-[#4c566a] px-2">
		{#each sessions as session (session.id)}
			<div
				class="flex shrink-0 items-center rounded-t transition-colors {activeId === session.id
					? 'bg-[#3b4252] text-[#eceff4]'
					: 'text-[#d8dee9]/60 hover:bg-[#3b4252]/60 hover:text-[#eceff4]'}"
			>
				<button
					class="flex items-center gap-1.5 px-3 py-1 text-xs font-medium"
					onclick={() => {
						onSetActive(session.id);
						if (!open) onToggle();
					}}
					type="button"
				>
					<Terminal size={12} />
					<span class="max-w-28 truncate">{session.name}</span>
				</button>
				<button
					class="pr-2 text-[#d8dee9]/40 transition-colors hover:text-[#bf616a]"
					onclick={() => closeSession(session.id)}
					type="button"
					aria-label="Close tab"
				>
					<X size={11} />
				</button>
			</div>
		{/each}

		<button
			onclick={addGenericShell}
			class="shrink-0 rounded p-1 text-[#d8dee9]/40 transition-colors hover:bg-[#3b4252]/60 hover:text-[#eceff4]"
			type="button"
			aria-label="New shell"
		>
			<Plus size={14} />
		</button>

		<!-- Spacer -->
		<div class="flex-1"></div>

		<!-- Maximize/Restore -->
		{#if open}
			<button
				onclick={toggleMaximize}
				class="shrink-0 rounded p-1 text-[#d8dee9]/60 transition-colors hover:bg-[#3b4252]/60 hover:text-[#eceff4]"
				type="button"
				aria-label={maximized ? 'Restore terminal' : 'Maximize terminal'}
			>
				{#if maximized}
					<Minimize2 size={14} />
				{:else}
					<Maximize2 size={14} />
				{/if}
			</button>
		{/if}

		<!-- Toggle drawer -->
		<button
			onclick={onToggle}
			class="shrink-0 rounded p-1 text-[#d8dee9]/60 transition-colors hover:bg-[#3b4252]/60 hover:text-[#eceff4]"
			type="button"
			aria-label="Toggle terminal drawer"
		>
			{#if open}
				<ChevronDown size={16} />
			{:else}
				<ChevronUp size={16} />
			{/if}
		</button>
	</div>

	<!-- Terminal content area -->
	{#if open}
		<div class="relative flex-1 overflow-hidden p-2">
			{#each sessions as session (session.id)}
				<div class="absolute inset-2">
					<TerminalTab
						sessionId={session.id}
						command={session.command}
						cwd={session.cwd ?? workspaceRoot}
						active={activeId === session.id}
						onExit={() => closeSession(session.id)}
					/>
				</div>
			{/each}
		</div>
	{/if}
</div>
