<script lang="ts">
	import { ChevronRight, ChevronDown, Play, Square, RotateCw, Loader2 } from 'lucide-svelte';
	import type { ContainerData } from '$lib/types';
	import SandboxRow from './SandboxRow.svelte';

	interface Props {
		projectName: string;
		containers: ContainerData[];
		hostname: string;
		onRefresh: () => Promise<void>;
	}

	let { projectName, containers, hostname, onRefresh }: Props = $props();

	let expanded = $state(false);
	let loadingAction = $state<string | null>(null);

	const runningCount = $derived(containers.filter((c) => c.state === 'running').length);
	const totalCount = $derived(containers.length);
	const anyRunning = $derived(runningCount > 0);

	async function handleGroupAction(action: 'start' | 'stop' | 'restart') {
		loadingAction = action;
		try {
			const targets = containers.filter((c) =>
				action === 'start' ? c.state !== 'running' : c.state === 'running'
			);
			await Promise.all(
				targets.map((c) => fetch(`/api/containers/${c.id}/${action}`, { method: 'POST' }))
			);
			await onRefresh();
		} finally {
			loadingAction = null;
		}
	}
</script>

<div>
	<!-- Summary row -->
	<div
		class="px-5 py-3 flex items-center justify-between gap-4 transition-colors
			{anyRunning
				? 'hover:bg-[#eceff4]/50 dark:hover:bg-[#434c5e]/50'
				: 'bg-[#e5e9f0]/50 dark:bg-[#2e3440]/30 opacity-80 hover:bg-[#e5e9f0] dark:hover:bg-[#2e3440]/50'}"
	>
		<button
			class="flex items-center gap-3 cursor-pointer bg-transparent border-none p-0 text-left flex-grow min-w-0"
			onclick={() => (expanded = !expanded)}
		>
			<!-- Expand/collapse icon -->
			<span class="text-[#4c566a] dark:text-[#d8dee9]/60 shrink-0">
				{#if expanded}
					<ChevronDown size={16} />
				{:else}
					<ChevronRight size={16} />
				{/if}
			</span>

			<!-- Status dot -->
			<div class="w-2 h-2 rounded-full shrink-0 {anyRunning ? 'bg-[#a3be8c]' : 'bg-[#4c566a]'}"></div>

			<!-- Project name -->
			<h4
				class="text-sm font-bold truncate
					{anyRunning ? 'text-[#2e3440] dark:text-[#eceff4]' : 'text-[#4c566a] dark:text-[#d8dee9]/70'}"
			>
				{projectName}
			</h4>

			<!-- Running count badge -->
			<span
				class="text-xs font-medium px-2 py-0.5 rounded-full
					{anyRunning
						? 'bg-[#a3be8c]/15 text-[#a3be8c] border border-[#a3be8c]/20'
						: 'bg-[#4c566a]/10 text-[#4c566a] dark:text-[#d8dee9]/50 border border-[#4c566a]/20'}"
			>
				{runningCount}/{totalCount} running
			</span>
		</button>

		<!-- Group actions -->
		<div
			class="shrink-0 flex items-center gap-1.5 p-1 rounded-xl border shadow-sm bg-[#eceff4] dark:bg-[#2e3440] border-[#d8dee9] dark:border-[#434c5e]"
			role="group"
		>
			{#if anyRunning}
				<button
					class="p-1.5 rounded-lg transition-colors text-[#4c566a] dark:text-[#d8dee9] hover:text-[#ebcb8b] dark:hover:text-[#ebcb8b] hover:bg-[#e5e9f0] dark:hover:bg-[#3b4252] disabled:opacity-50 disabled:cursor-not-allowed"
					disabled={loadingAction !== null}
					onclick={() => handleGroupAction('restart')}
					title="Restart all"
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
					onclick={() => handleGroupAction('stop')}
					title="Stop all"
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
					onclick={() => handleGroupAction('start')}
					title="Start all"
				>
					{#if loadingAction === 'start'}
						<Loader2 size={16} class="animate-spin" />
					{:else}
						<Play size={16} class="fill-current" />
					{/if}
				</button>
			{/if}
		</div>
	</div>

	<!-- Expanded container list -->
	{#if expanded}
		<div class="bg-[#f0f4f8] dark:bg-[#2e3440]">
			<div class="divide-y divide-[#d8dee9]/60 dark:divide-[#4c566a]/60">
				{#each containers as container (container.id)}
					<SandboxRow {container} {hostname} {onRefresh} />
				{/each}
			</div>
		</div>
	{/if}
</div>
