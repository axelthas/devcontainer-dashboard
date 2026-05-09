<script lang="ts">
	import type { ContainerData } from '$lib/types';
	import ServiceButton from './ServiceButton.svelte';
	import ActionControls from './ActionControls.svelte';

	interface Props {
		container: ContainerData;
		onRefresh: () => Promise<void>;
	}

	let { container, onRefresh }: Props = $props();

	const isRunning = $derived(container.state === 'running');
	const stateColor = $derived(isRunning ? 'text-[#a3be8c]' : 'text-[#bf616a]');
</script>

<div
	class="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:gap-4
		border-[#434c5e] bg-[#3b4252]"
>
	<!-- Name & state -->
	<div class="flex min-w-0 flex-1 items-center gap-3">
		<span class="h-2 w-2 shrink-0 rounded-full {isRunning ? 'bg-[#a3be8c]' : 'bg-[#bf616a]'}"></span>
		<div class="min-w-0">
			<span class="block truncate font-medium text-[#eceff4]">{container.projectName}</span>
			<span class="block truncate text-xs {stateColor}">{container.state}</span>
		</div>
	</div>

	<!-- Service buttons -->
	<div class="flex flex-wrap gap-1.5">
		{#each Object.entries(container.ports) as [containerPort, hostPort]}
			<ServiceButton {containerPort} {hostPort} running={isRunning} />
		{/each}
	</div>

	<!-- Action controls -->
	<div class="shrink-0">
		<ActionControls id={container.id} containerState={container.state} {onRefresh} />
	</div>
</div>
