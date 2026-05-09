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
	const stateColor = $derived(isRunning ? 'bg-[#a3be8c]' : 'bg-[#bf616a]');
</script>

<div
	class="flex flex-col gap-4 rounded-xl border p-5 shadow-sm transition-all
		border-[#434c5e] bg-[#3b4252] dark:border-[#434c5e] dark:bg-[#3b4252]
		light:border-[#d8dee9] light:bg-white"
>
	<!-- Header -->
	<div class="flex items-start justify-between gap-2">
		<div class="min-w-0">
			<h3 class="truncate text-lg font-semibold text-[#eceff4]">{container.projectName}</h3>
			<p class="truncate text-xs text-[#81a1c1]">{container.name}</p>
		</div>
		<span
			class="mt-1 shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium text-[#2e3440] {stateColor}"
		>
			{container.state}
		</span>
	</div>

	<!-- Service Buttons -->
	<div class="flex flex-wrap gap-2">
		{#each Object.entries(container.ports) as [containerPort, hostPort]}
			<ServiceButton {containerPort} {hostPort} running={isRunning} />
		{/each}
	</div>

	<!-- Action Controls -->
	<div class="border-t border-[#434c5e] pt-3">
		<ActionControls id={container.id} containerState={container.state} {onRefresh} />
	</div>
</div>
