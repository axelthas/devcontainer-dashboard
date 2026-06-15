<script lang="ts">
	import type { ContainerData } from '$lib/types';
	import { generateId } from '$lib/index';
	import { buildContainerVscodeUri } from '$lib/vscode';
	import ServiceButton from './ServiceButton.svelte';
	import ActionControls from './ActionControls.svelte';

	interface Props {
		container: ContainerData;
		vscodeSshHost?: string;
		onRefresh: () => Promise<void>;
		onOpenTerminal?: (id: string, command: string, name: string, cwd: string) => void;
	}

	let { container, vscodeSshHost, onRefresh, onOpenTerminal }: Props = $props();

	const isRunning = $derived(container.state === 'running');

	const vscodeUri = $derived.by(() => {
		return buildContainerVscodeUri(container, vscodeSshHost);
	});

	const terminalParams = $derived.by(() => {
		const containerName = container.name.replace(/^\//, '');
		if (container.state === 'running') {
			return {
				command: `docker exec -it ${containerName} bash`,
				cwd: container.localWorkspacePath ?? ''
			};
		}
		if (container.localWorkspacePath) {
			return { command: '', cwd: container.localWorkspacePath };
		}
		return null;
	});

	function openTerminal() {
		if (!onOpenTerminal || !terminalParams) return;
		onOpenTerminal(generateId(), terminalParams.command, container.projectName, terminalParams.cwd);
	}
</script>
<div
	data-container-id={container.id}
	class="flex flex-col rounded-2xl border transition-all duration-300
		{isRunning
		? 'border-[#d8dee9] bg-white shadow-md hover:border-[#81a1c1] hover:shadow-lg dark:border-[#4c566a] dark:bg-[#3b4252] dark:hover:border-[#81a1c1]/50'
		: 'border-[#d8dee9] bg-[#e5e9f0] opacity-80 shadow-sm dark:border-[#434c5e] dark:bg-[#3b4252]/50'}"
>
	<!-- Card Header -->
	<div
		class="flex items-start justify-between rounded-t-2xl border-b p-5
			{isRunning
			? 'border-[#d8dee9] bg-[#eceff4]/50 dark:border-[#4c566a] dark:bg-[#2e3440]'
			: 'border-[#d8dee9] bg-[#e5e9f0] dark:border-[#434c5e] dark:bg-[#2e3440]/50'}"
	>
		<div>
			<div class="mb-1 flex items-center gap-2">
				<span
					class="h-2.5 w-2.5 shrink-0 rounded-full
						{isRunning ? 'bg-[#a3be8c] shadow-[0_0_8px_rgba(163,190,140,0.5)]' : 'bg-[#4c566a]'}"
				></span>
				<h3
					class="text-lg font-bold
						{isRunning ? 'text-[#2e3440] dark:text-[#eceff4]' : 'text-[#4c566a] dark:text-[#d8dee9]/70'}"
				>
					{container.projectName}
					<span class="text-sm font-normal text-[#4c566a] dark:text-[#d8dee9]/50"
						>({container.name.replace(/^\//, '')})</span
					>
				</h3>
			</div>
			<div class="mt-0.5 flex items-center gap-1.5">
				{#if container.localWorkspacePath}
					<p class="font-mono text-xs break-all text-[#4c566a] dark:text-[#d8dee9]/50">
						{container.localWorkspacePath.split('/').filter(Boolean).at(-2) ??
							container.localWorkspacePath}
					</p>
				{/if}
			</div>
		</div>
		<ActionControls id={container.id} containerState={container.state} {onRefresh} {vscodeUri} onOpenTerminal={onOpenTerminal && terminalParams ? openTerminal : undefined} />
	</div>

	<!-- Card Services Grid -->
	<div class="flex-grow p-5">
		<div class="grid grid-cols-2 gap-3">
			{#each Object.entries(container.ports) as [containerPort, hostPort] (containerPort)}
				<ServiceButton
					{containerPort}
					{hostPort}
					running={isRunning}
					variant="card"
					containerName={container.name}
					projectName={container.projectName}
					workspacePath={container.localWorkspacePath}
					allPorts={container.ports}
				/>
			{/each}
		</div>
	</div>
</div>
