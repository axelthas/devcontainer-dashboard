<script lang="ts">
	import type { ContainerData } from '$lib/types';
	import { generateId } from '$lib/index';
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

	/** Hex-encode a string (UTF-8 bytes → hex), matching xxd/od output used by VS Code. */
	function hexEncode(str: string): string {
		return Array.from(new TextEncoder().encode(str))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
	}

	const vscodeUri = $derived.by(() => {
		if (!container.localWorkspacePath) {
			if (!isRunning) return '';
			const containerName = container.name.startsWith('/') ? container.name : `/${container.name}`;
			return `vscode://ms-vscode-remote.remote-containers/attachToRunningContainer?containerName=${containerName}&windowId=_blank`;
		}
		const hexPath = hexEncode(container.localWorkspacePath);
		const basename = container.localWorkspacePath.split('/').filter(Boolean).at(-1) ?? '';
		const containerWorkspace = `/workspace/${basename}`;
		if (vscodeSshHost) {
			return `vscode://vscode-remote/dev-container+${hexPath}@ssh-remote+${vscodeSshHost}${containerWorkspace}?windowId=_blank`;
		}
		return `vscode://vscode-remote/dev-container+${hexPath}${containerWorkspace}?windowId=_blank`;
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
	class="flex flex-col justify-between gap-4 px-5 py-3 transition-all duration-300 md:flex-row md:items-center
		{isRunning
		? 'hover:bg-[#eceff4]/50 dark:hover:bg-[#434c5e]/50'
		: 'bg-[#e5e9f0]/50 opacity-80 hover:bg-[#e5e9f0] dark:bg-[#2e3440]/30 dark:hover:bg-[#2e3440]/50'}"
>
	<!-- Identifier -->
	<div class="flex w-full items-center gap-4 md:w-1/3">
		<div
			class="h-2.5 w-2.5 shrink-0 rounded-full {isRunning
				? 'bg-[#a3be8c] shadow-[0_0_8px_rgba(163,190,140,0.5)]'
				: 'bg-[#4c566a]'}"
		></div>
		<div class="min-w-0">
			<h4
				class="truncate text-sm font-bold
					{isRunning ? 'text-[#2e3440] dark:text-[#eceff4]' : 'text-[#4c566a] dark:text-[#d8dee9]/70'}"
			>
				{container.projectName}
				<span class="text-xs font-normal text-[#4c566a] dark:text-[#d8dee9]/50"
					>({container.name.replace(/^\//, '')})</span
				>
			</h4>
			{#if container.localWorkspacePath}
				<p class="truncate font-mono text-xs text-[#4c566a] dark:text-[#d8dee9]/50">
					{container.localWorkspacePath.split('/').filter(Boolean).at(-2) ??
						container.localWorkspacePath}
				</p>
			{/if}
		</div>
	</div>

	<!-- Exposed Services -->
	<div class="flex flex-grow flex-wrap gap-2">
		{#each Object.entries(container.ports) as [containerPort, hostPort]}
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
		<ActionControls id={container.id} containerState={container.state} {onRefresh} {vscodeUri} onOpenTerminal={onOpenTerminal && terminalParams ? openTerminal : undefined} />
	</div>
</div>
