<script lang="ts">
	import { ChevronRight, ChevronDown, Play, Square, RotateCw, Loader2 } from 'lucide-svelte';
	import type { ContainerData } from '$lib/types';
	import SandboxRow from './SandboxRow.svelte';

	interface Props {
		projectName: string;
		containers: ContainerData[];
		hostname: string;
		vscodeSshHost: string;
		onRefresh: () => Promise<void>;
	}

	let { projectName, containers, hostname, vscodeSshHost, onRefresh }: Props = $props();

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
		class="flex items-center justify-between gap-4 px-5 py-3 transition-colors
			{anyRunning
			? 'hover:bg-[#eceff4]/50 dark:hover:bg-[#434c5e]/50'
			: 'bg-[#e5e9f0]/50 opacity-80 hover:bg-[#e5e9f0] dark:bg-[#2e3440]/30 dark:hover:bg-[#2e3440]/50'}"
	>
		<button
			class="flex min-w-0 flex-grow cursor-pointer items-center gap-3 border-none bg-transparent p-0 text-left"
			onclick={() => (expanded = !expanded)}
		>
			<!-- Expand/collapse icon -->
			<span class="shrink-0 text-[#4c566a] dark:text-[#d8dee9]/60">
				{#if expanded}
					<ChevronDown size={16} />
				{:else}
					<ChevronRight size={16} />
				{/if}
			</span>

			<!-- Status dot -->
			<div
				class="h-2 w-2 shrink-0 rounded-full {anyRunning ? 'bg-[#a3be8c]' : 'bg-[#4c566a]'}"
			></div>

			<!-- Project name -->
			<h4
				class="truncate text-sm font-bold
					{anyRunning ? 'text-[#2e3440] dark:text-[#eceff4]' : 'text-[#4c566a] dark:text-[#d8dee9]/70'}"
			>
				{projectName}
			</h4>

			<!-- Running count badge -->
			<span
				class="rounded-full px-2 py-0.5 text-xs font-medium
					{anyRunning
					? 'border border-[#a3be8c]/20 bg-[#a3be8c]/15 text-[#a3be8c]'
					: 'border border-[#4c566a]/20 bg-[#4c566a]/10 text-[#4c566a] dark:text-[#d8dee9]/50'}"
			>
				{runningCount}/{totalCount} running
			</span>
		</button>

		<!-- Group actions -->
		<div
			class="flex shrink-0 items-center gap-1.5 rounded-xl border border-[#d8dee9] bg-[#eceff4] p-1 shadow-sm dark:border-[#434c5e] dark:bg-[#2e3440]"
			role="group"
		>
			{#if anyRunning}
				<button
					class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#ebcb8b] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#ebcb8b]"
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
					class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#bf616a] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#bf616a]"
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
					class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#a3be8c] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#a3be8c]"
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
					<SandboxRow {container} {hostname} {vscodeSshHost} {onRefresh} />
				{/each}
			</div>
		</div>
	{/if}
</div>
