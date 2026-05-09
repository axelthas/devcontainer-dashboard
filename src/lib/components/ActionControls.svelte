<script lang="ts">
	import { Play, Square, RotateCcw, Loader2 } from 'lucide-svelte';

	interface Props {
		id: string;
		containerState: string;
		onRefresh: () => Promise<void>;
	}

	let { id, containerState, onRefresh }: Props = $props();

	let loadingAction = $state<string | null>(null);

	async function handleAction(action: 'start' | 'stop' | 'restart') {
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

<div class="flex gap-1.5">
	{#if !isRunning}
		<button
			class="flex items-center gap-1 rounded px-2 py-1 text-sm font-medium text-white transition-colors
				bg-[#a3be8c] hover:bg-[#a3be8c]/80 disabled:cursor-not-allowed disabled:opacity-50"
			disabled={loadingAction !== null}
			onclick={() => handleAction('start')}
			title="Start"
		>
			{#if loadingAction === 'start'}
				<Loader2 size={14} class="animate-spin" />
			{:else}
				<Play size={14} />
			{/if}
			Start
		</button>
	{:else}
		<button
			class="flex items-center gap-1 rounded px-2 py-1 text-sm font-medium text-white transition-colors
				bg-[#bf616a] hover:bg-[#bf616a]/80 disabled:cursor-not-allowed disabled:opacity-50"
			disabled={loadingAction !== null}
			onclick={() => handleAction('stop')}
			title="Stop"
		>
			{#if loadingAction === 'stop'}
				<Loader2 size={14} class="animate-spin" />
			{:else}
				<Square size={14} />
			{/if}
			Stop
		</button>
	{/if}

	<button
		class="flex items-center gap-1 rounded px-2 py-1 text-sm font-medium transition-colors
			bg-[#ebcb8b] hover:bg-[#d08770] disabled:cursor-not-allowed disabled:opacity-50 text-[#2e3440]"
		disabled={loadingAction !== null}
		onclick={() => handleAction('restart')}
		title="Restart"
	>
		{#if loadingAction === 'restart'}
			<Loader2 size={14} class="animate-spin" />
		{:else}
			<RotateCcw size={14} />
		{/if}
		Restart
	</button>
</div>
