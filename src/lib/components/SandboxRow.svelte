<script lang="ts">
	import type { ContainerData } from '$lib/types';
	import { buildContainerVscodeUri } from '$lib/vscode';
	import ServiceButton from './ServiceButton.svelte';
	import ActionControls from './ActionControls.svelte';

	interface Props {
		container: ContainerData;
		vscodeSshHost: string;
		onRefresh: () => Promise<void>;
	}

	let { container, vscodeSshHost, onRefresh }: Props = $props();

	const isRunning = $derived(container.state === 'running');

	const vscodeUri = $derived.by(() => {
		return buildContainerVscodeUri(container, vscodeSshHost);
	});
</script>

<div
	class="flex flex-col justify-between gap-4 px-5 py-3 transition-colors md:flex-row md:items-center
		{isRunning
		? 'hover:bg-[#eceff4]/50 dark:hover:bg-[#434c5e]/50'
		: 'bg-[#e5e9f0]/50 opacity-80 hover:bg-[#e5e9f0] dark:bg-[#2e3440]/30 dark:hover:bg-[#2e3440]/50'}"
>
	<!-- Identifier -->
	<div class="flex w-full items-center gap-4 md:w-1/3">
		<div class="h-2 w-2 shrink-0 rounded-full {isRunning ? 'bg-[#a3be8c]' : 'bg-[#4c566a]'}"></div>
		<div class="min-w-0">
			<h4
				class="truncate text-sm font-bold
					{isRunning ? 'text-[#2e3440] dark:text-[#eceff4]' : 'text-[#4c566a] dark:text-[#d8dee9]/70'}"
			>
				{container.projectName}
			</h4>
			<p class="truncate font-mono text-xs text-[#4c566a] dark:text-[#d8dee9]/60">
				{container.name}
			</p>
		</div>
	</div>

	<!-- Exposed Services -->
	<div class="flex flex-grow flex-wrap gap-2">
		{#each Object.entries(container.ports) as [containerPort, hostPort] (containerPort)}
			<ServiceButton
				{containerPort}
				{hostPort}
				running={isRunning}
				variant="row"
				containerName={container.name}
				projectName={container.projectName}
				workspacePath={container.localWorkspacePath}
				allPorts={container.ports}
			/>
		{/each}
	</div>

	<!-- Actions -->
	<div class="flex shrink-0 items-center justify-end">
		<ActionControls id={container.id} containerState={container.state} {onRefresh} {vscodeUri} />
	</div>
</div>
