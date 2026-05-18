<script lang="ts">
	import { Play, Square, RotateCw, Loader2, Trash2 } from 'lucide-svelte';

	interface Props {
		id: string;
		containerState: string;
		onRefresh: () => Promise<void>;
	}

	let { id, containerState, onRefresh }: Props = $props();

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
	class="flex items-center gap-1.5 p-1 rounded-xl border shadow-sm bg-[#eceff4] dark:bg-[#2e3440] border-[#d8dee9] dark:border-[#434c5e]"
>
	{#if isRunning}
		<button
			class="p-1.5 rounded-lg transition-colors text-[#4c566a] dark:text-[#d8dee9] hover:text-[#ebcb8b] dark:hover:text-[#ebcb8b] hover:bg-[#e5e9f0] dark:hover:bg-[#3b4252] disabled:opacity-50 disabled:cursor-not-allowed"
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
			class="p-1.5 rounded-lg transition-colors text-[#4c566a] dark:text-[#d8dee9] hover:text-[#bf616a] dark:hover:text-[#bf616a] hover:bg-[#e5e9f0] dark:hover:bg-[#3b4252] disabled:opacity-50 disabled:cursor-not-allowed"
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
			class="p-1.5 rounded-lg transition-colors text-[#4c566a] dark:text-[#d8dee9] hover:text-[#a3be8c] dark:hover:text-[#a3be8c] hover:bg-[#e5e9f0] dark:hover:bg-[#3b4252] disabled:opacity-50 disabled:cursor-not-allowed"
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
		class="p-1.5 rounded-lg transition-colors text-[#4c566a] dark:text-[#d8dee9] hover:text-[#bf616a] dark:hover:text-[#bf616a] hover:bg-[#e5e9f0] dark:hover:bg-[#3b4252] disabled:opacity-50 disabled:cursor-not-allowed"
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
