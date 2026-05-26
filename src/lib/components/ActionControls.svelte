<script lang="ts">
	import { Play, Square, RotateCw, Loader2, Trash2, Code, TerminalSquare } from 'lucide-svelte';

	interface Props {
		id: string;
		containerState: string;
		onRefresh: () => Promise<void>;
		vscodeUri?: string;
		onOpenTerminal?: () => void;
	}

	let { id, containerState, onRefresh, vscodeUri, onOpenTerminal }: Props = $props();

	let loadingAction = $state<string | null>(null);

	async function handleAction(action: 'start' | 'stop' | 'restart' | 'delete') {
		if (action === 'delete' && !confirm('Delete this container? This cannot be undone.')) {
			return;
		}
		loadingAction = action;
		try {
			await fetch(`/api/containers/${id}/${action}`, { method: 'POST' });
			await onRefresh();
		} finally {
			loadingAction = null;
		}
	}

	const isRunning = $derived(containerState === 'running');
</script>

<div
	class="flex items-center gap-1.5 rounded-xl border border-[#d8dee9] bg-[#eceff4] p-1 shadow-sm dark:border-[#434c5e] dark:bg-[#2e3440]"
>
	{#if vscodeUri}
		<a
			href={vscodeUri}
			rel="external"
			title="Open in VS Code"
			class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#5e81ac] dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#81a1c1]"
		>
			<Code size={16} />
		</a>
	{/if}
	{#if onOpenTerminal}
		<button
			onclick={onOpenTerminal}
			title="Open terminal"
			class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#88c0d0] dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#88c0d0]"
		>
			<TerminalSquare size={16} />
		</button>
	{/if}
	{#if isRunning}
		<button
			class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#ebcb8b] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#ebcb8b]"
			disabled={loadingAction !== null}
			onclick={() => handleAction('restart')}
			title="Restart"
		>
			{#if loadingAction === 'restart'}
				<Loader2 size={16} class="animate-spin" />
			{:else}
				<RotateCw size={16} />
			{/if}
		</button>
		<button
			class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#bf616a] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#bf616a]"
			disabled={loadingAction !== null}
			onclick={() => handleAction('stop')}
			title="Stop"
		>
			{#if loadingAction === 'stop'}
				<Loader2 size={16} class="animate-spin" />
			{:else}
				<Square size={16} class="fill-current" />
			{/if}
		</button>
	{:else}
		<button
			class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#a3be8c] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#a3be8c]"
			disabled={loadingAction !== null}
			onclick={() => handleAction('start')}
			title="Start"
		>
			{#if loadingAction === 'start'}
				<Loader2 size={16} class="animate-spin" />
			{:else}
				<Play size={16} class="fill-current" />
			{/if}
		</button>
	{/if}
	<button
		class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#bf616a] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#bf616a]"
		disabled={loadingAction !== null}
		onclick={() => handleAction('delete')}
		title="Delete container"
	>
		{#if loadingAction === 'delete'}
			<Loader2 size={16} class="animate-spin" />
		{:else}
			<Trash2 size={16} />
		{/if}
	</button>
</div>
