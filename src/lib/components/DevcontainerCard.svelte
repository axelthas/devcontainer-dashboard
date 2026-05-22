<script lang="ts">
	import type { ContainerData } from '$lib/types';
	import ServiceButton from './ServiceButton.svelte';
	import ActionControls from './ActionControls.svelte';

	interface Props {
		container: ContainerData;
		hostname: string;
		vscodeSshHost?: string;
		onRefresh: () => Promise<void>;
	}

	let { container, hostname, vscodeSshHost, onRefresh }: Props = $props();

	const isRunning = $derived(container.state === 'running');

	/** Hex-encode a string (UTF-8 bytes → hex), matching xxd/od output used by VS Code. */
	function hexEncode(str: string): string {
		return Array.from(new TextEncoder().encode(str))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
	}

	const vscodeUri = $derived.by(() => {
		if (!container.localWorkspacePath) {
			// No workspace path label: fall back to attach-by-name for local running containers.
			if (!isRunning) return '';
			const containerName = container.name.startsWith('/') ? container.name : `/${container.name}`;
			return `vscode://ms-vscode-remote.remote-containers/attachToRunningContainer?containerName=${containerName}&windowId=_blank`;
		}
		// Use vscode://vscode-remote/ which is browser-clickable (vscode:// is an OS protocol handler).
		// VS Code internally resolves this to vscode-remote://dev-container+<hex>[...]<path>
		// windowId=_blank forces a new VS Code window instead of reusing an existing one.
		const hexPath = hexEncode(container.localWorkspacePath);
		const basename = container.localWorkspacePath.split('/').filter(Boolean).at(-1) ?? '';
		const containerWorkspace = `/workspace/${basename}`;
		if (vscodeSshHost) {
			return `vscode://vscode-remote/dev-container+${hexPath}@ssh-remote+${vscodeSshHost}${containerWorkspace}?windowId=_blank`;
		}
		return `vscode://vscode-remote/dev-container+${hexPath}${containerWorkspace}?windowId=_blank`;
	});
</script>

<div
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
						{container.localWorkspacePath}
					</p>
				{/if}
			</div>
		</div>
		<ActionControls id={container.id} containerState={container.state} {onRefresh} {vscodeUri} />
	</div>

	<!-- Card Services Grid -->
	<div class="flex-grow p-5">
		<div class="grid grid-cols-2 gap-3">
			{#each Object.entries(container.ports) as [containerPort, hostPort] (containerPort)}
				<ServiceButton
					{containerPort}
					{hostPort}
					{hostname}
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
