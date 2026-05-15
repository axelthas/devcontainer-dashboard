<script lang="ts">
	import { X, Plus, Terminal, ChevronDown, ChevronUp } from 'lucide-svelte';
	import TerminalTab from './TerminalTab.svelte';
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

	let { open, sessions, activeId, workspaceRoot, onToggle, onAddSession, onRemoveSession, onSetActive }: Props = $props();

	function addGenericShell() {
		const id = crypto.randomUUID();
		onAddSession({ id, name: 'Shell', cwd: workspaceRoot });
		onSetActive(id);
		if (!open) onToggle();
	}

	function closeSession(id: string) {
		onRemoveSession(id);
	}
</script>

<!-- Terminal drawer — fixed bottom -->
<div
	class="fixed bottom-0 left-0 right-0 z-40 flex flex-col border-t border-[#4c566a] bg-[#2e3440] transition-all duration-300 {open
		? 'h-80'
		: 'h-10'}"
>
	<!-- Tab bar -->
	<div class="flex items-center h-10 px-2 gap-1 border-b border-[#4c566a] shrink-0 overflow-x-auto">
		{#each sessions as session (session.id)}
			<div
				class="flex items-center shrink-0 rounded-t transition-colors {activeId === session.id
					? 'bg-[#3b4252] text-[#eceff4]'
					: 'text-[#d8dee9]/60 hover:text-[#eceff4] hover:bg-[#3b4252]/60'}"
			>
				<button
					class="flex items-center gap-1.5 px-3 py-1 text-xs font-medium"
					onclick={() => { onSetActive(session.id); if (!open) onToggle(); }}
					type="button"
				>
					<Terminal size={12} />
					<span class="max-w-28 truncate">{session.name}</span>
				</button>
				<button
					class="pr-2 text-[#d8dee9]/40 hover:text-[#bf616a] transition-colors"
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
			class="p-1 rounded text-[#d8dee9]/40 hover:text-[#eceff4] hover:bg-[#3b4252]/60 shrink-0 transition-colors"
			type="button"
			aria-label="New shell"
		>
			<Plus size={14} />
		</button>

		<!-- Spacer -->
		<div class="flex-1"></div>

		<!-- Toggle drawer -->
		<button
			onclick={onToggle}
			class="p-1 rounded text-[#d8dee9]/60 hover:text-[#eceff4] hover:bg-[#3b4252]/60 shrink-0 transition-colors"
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
		<div class="flex-1 overflow-hidden p-2 relative">
			{#each sessions as session (session.id)}
				<div class="absolute inset-2">
					<TerminalTab
						sessionId={session.id}
						command={session.command}
						cwd={session.cwd ?? workspaceRoot}
						active={activeId === session.id}
					/>
				</div>
			{/each}
		</div>
	{/if}
</div>
