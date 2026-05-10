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
	class="rounded-2xl border transition-all duration-300 flex flex-col
		{isRunning
			? 'bg-white dark:bg-[#3b4252] border-[#d8dee9] dark:border-[#4c566a] shadow-md hover:shadow-lg hover:border-[#81a1c1] dark:hover:border-[#81a1c1]/50'
			: 'bg-[#e5e9f0] dark:bg-[#3b4252]/50 border-[#d8dee9] dark:border-[#434c5e] shadow-sm opacity-80'}"
>
	<!-- Card Header -->
	<div
		class="p-5 border-b flex justify-between items-start rounded-t-2xl
			{isRunning
				? 'bg-[#eceff4]/50 dark:bg-[#2e3440] border-[#d8dee9] dark:border-[#4c566a]'
				: 'bg-[#e5e9f0] dark:bg-[#2e3440]/50 border-[#d8dee9] dark:border-[#434c5e]'}"
	>
		<div>
			<div class="flex items-center gap-2 mb-1">
				<span
					class="w-2.5 h-2.5 rounded-full shrink-0
						{isRunning
							? 'bg-[#a3be8c] shadow-[0_0_8px_rgba(163,190,140,0.5)]'
							: 'bg-[#4c566a]'}"
				></span>
				<h3
					class="text-lg font-bold
						{isRunning
							? 'text-[#2e3440] dark:text-[#eceff4]'
							: 'text-[#4c566a] dark:text-[#d8dee9]/70'}"
				>
					{container.projectName}
					<span class="text-sm font-normal text-[#4c566a] dark:text-[#d8dee9]/50">({container.name.replace(/^\//, '')})</span>
				</h3>
			</div>
			{#if container.localWorkspacePath}
				<p class="text-xs font-mono break-all text-[#4c566a] dark:text-[#d8dee9]/50 mt-0.5">
					{container.localWorkspacePath}
				</p>
			{/if}
		</div>
		<ActionControls id={container.id} containerState={container.state} {onRefresh} />
	</div>

	<!-- Card Services Grid -->
	<div class="p-5 flex-grow">
		<div class="grid grid-cols-2 gap-3">
			{#each Object.entries(container.ports) as [containerPort, hostPort]}
				<ServiceButton
					{containerPort}
					{hostPort}
					{hostname}
					running={isRunning}
					variant="card"
					containerName={container.name}
					projectName={container.projectName}
					workspacePath={container.localWorkspacePath}
				/>
			{/each}
		</div>
	</div>
</div>
