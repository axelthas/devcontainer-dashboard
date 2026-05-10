<script lang="ts">
	import type { ContainerData } from '$lib/types';
	import ServiceButton from './ServiceButton.svelte';
	import ActionControls from './ActionControls.svelte';

	interface Props {
		container: ContainerData;
		hostname: string;
		onRefresh: () => Promise<void>;
	}

	let { container, hostname, onRefresh }: Props = $props();

	const isRunning = $derived(container.state === 'running');
</script>

<div
	class="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 transition-colors
		{isRunning
			? 'hover:bg-[#eceff4]/50 dark:hover:bg-[#434c5e]/50'
			: 'bg-[#e5e9f0]/50 dark:bg-[#2e3440]/30 opacity-80 hover:bg-[#e5e9f0] dark:hover:bg-[#2e3440]/50'}"
>
	<!-- Identifier -->
	<div class="flex items-center gap-4 w-full md:w-1/3">
		<div class="w-2 h-2 rounded-full shrink-0 {isRunning ? 'bg-[#a3be8c]' : 'bg-[#4c566a]'}"></div>
		<div class="min-w-0">
			<h4
				class="text-sm font-bold truncate
					{isRunning ? 'text-[#2e3440] dark:text-[#eceff4]' : 'text-[#4c566a] dark:text-[#d8dee9]/70'}"
			>
				{container.projectName}
			</h4>
			<p class="text-xs font-mono truncate text-[#4c566a] dark:text-[#d8dee9]/60">{container.name}</p>
		</div>
	</div>

	<!-- Exposed Services -->
	<div class="flex flex-wrap gap-2 flex-grow">
		{#each Object.entries(container.ports) as [containerPort, hostPort]}
			<ServiceButton
				{containerPort}
				{hostPort}
				{hostname}
				running={isRunning}
				variant="row"
				containerName={container.name}
				projectName={container.projectName}
				workspacePath={container.localWorkspacePath}
			/>
		{/each}
	</div>

	<!-- Actions -->
	<div class="shrink-0 flex items-center justify-end">
		<ActionControls id={container.id} containerState={container.state} {onRefresh} />
	</div>
</div>
