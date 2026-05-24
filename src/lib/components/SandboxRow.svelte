<script lang="ts">
	import { Code } from 'lucide-svelte';
	import type { ContainerData } from '$lib/types';
	import ServiceButton from './ServiceButton.svelte';
	import ActionControls from './ActionControls.svelte';

	interface Props {
		container: ContainerData;
		hostname: string;
		vscodeSshHost: string;
		onRefresh: () => Promise<void>;
	}

	let { container, hostname, vscodeSshHost: _vscodeSshHost, onRefresh }: Props = $props();

	const isRunning = $derived(container.state === 'running');

	const attachUri = $derived(
		isRunning
			? `vscode://ms-vscode-remote.remote-containers/attachToRunningContainer?containerName=${container.name.startsWith('/') ? container.name : '/' + container.name}&windowId=_blank`
			: ''
	);
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
				{hostname}
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
	<div class="flex shrink-0 items-center justify-end gap-1.5">
		{#if attachUri}
			<a
				href={attachUri}
				rel="external"
				title="Attach VS Code to container"
				class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#5e81ac] dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#81a1c1]"
			>
				<Code size={16} />
			</a>
		{/if}
		<ActionControls id={container.id} containerState={container.state} {onRefresh} />
	</div>
</div>
