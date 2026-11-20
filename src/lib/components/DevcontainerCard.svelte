<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Loader2, Play } from 'lucide-svelte';
	import type { ContainerData } from '$lib/types';
	import { ContainerActions, TRANSITION_LABELS } from '$lib/containerActions.svelte';
	import ServiceButton from './ServiceButton.svelte';
	import OpenWithMenu from './OpenWithMenu.svelte';
	import ContainerMoreMenu from './ContainerMoreMenu.svelte';
	import BrainAccessButton from './BrainAccessButton.svelte';
	import { NetworkActions } from '$lib/networkActions.svelte';

	interface Props {
		container: ContainerData;
		vscodeSshHost?: string;
		serviceProxyEnabled?: boolean;
		onRefresh: () => Promise<void>;
		onOpenTerminal?: (id: string, command: string, name: string, cwd: string) => void;
		/** Open the network drawer for this container */
		onConnectNetwork?: (container: ContainerData, network?: string, seatIp?: string) => void;
	}

	let {
		container,
		vscodeSshHost,
		serviceProxyEnabled,
		onRefresh,
		onOpenTerminal,
		onConnectNetwork
	}: Props = $props();

	// Lifecycle requests and rebuild polling; disposing never cancels a server-side rebuild.
	const actions = new ContainerActions(() => ({
		id: container.id,
		onRefresh,
		rebuildContainer: container,
		onOpenBuild: onOpenTerminal
	}));
	onDestroy(() => actions.dispose());
	const networkActions = new NetworkActions(() => ({ container, onRefresh, onConnectNetwork }));
	const connectThis = () => onConnectNetwork?.(container);

	const isRunning = $derived(container.state === 'running');
	const transition = $derived(
		actions.loadingAction ? TRANSITION_LABELS[actions.loadingAction] : ''
	);
	const openTerminal = (id: string, command: string, name: string, cwd: string) =>
		onOpenTerminal?.(id, command, name, cwd);
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
		class="flex flex-col items-stretch justify-between gap-3 rounded-t-2xl border-b p-4 sm:flex-row sm:items-start sm:p-5
			{isRunning
			? 'border-[#d8dee9] bg-[#eceff4]/50 dark:border-[#4c566a] dark:bg-[#2e3440]'
			: 'border-[#d8dee9] bg-[#e5e9f0] dark:border-[#434c5e] dark:bg-[#2e3440]/50'}"
	>
		<div class="min-w-0">
			<div class="mb-1 flex items-center gap-2">
				<span
					class="h-2.5 w-2.5 shrink-0 rounded-full
						{transition
						? 'animate-pulse bg-[#ebcb8b]'
						: isRunning
							? 'bg-[#a3be8c] shadow-[0_0_8px_rgba(163,190,140,0.5)]'
							: 'bg-[#4c566a]'}"
				></span>
				<h3
					class="min-w-0 text-lg font-bold break-words sm:truncate
						{isRunning ? 'text-[#2e3440] dark:text-[#eceff4]' : 'text-[#4c566a] dark:text-[#d8dee9]/70'}"
				>
					{container.projectName}
					<span
						class="block font-mono text-sm font-normal break-all text-[#4c566a] sm:inline sm:font-sans dark:text-[#d8dee9]/50"
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
		<div class="flex shrink-0 flex-col items-start gap-1 sm:items-end">
			<div class="flex flex-wrap items-center gap-2">
				{#if transition}
					<span role="status" class="flex items-center gap-1.5 text-xs font-medium text-[#ebcb8b]">
						<Loader2 size={12} class="animate-spin" />
						{transition}…
					</span>
				{:else if !isRunning}
					<button
						type="button"
						onclick={() => void actions.run('start')}
						class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium whitespace-nowrap text-[#a3be8c] transition-colors hover:bg-[#e5e9f0] dark:hover:bg-[#434c5e]"
					>
						<Play size={12} class="fill-current" />
						Start
					</button>
				{/if}
				{#if !transition}
					<BrainAccessButton {container} />
				{/if}
				<div
					class="flex items-center rounded-xl border border-[#d8dee9] bg-[#eceff4] p-1 shadow-sm dark:border-[#434c5e] dark:bg-[#2e3440]"
				>
					<OpenWithMenu
						path={container.localWorkspacePath ?? ''}
						{container}
						{vscodeSshHost}
						{serviceProxyEnabled}
						disabled={Boolean(transition)}
						onOpenTerminal={openTerminal}
					/>
					<div class="mx-0.5 h-4 w-px shrink-0 bg-[#d8dee9] dark:bg-[#434c5e]"></div>
					<ContainerMoreMenu
						{container}
						{actions}
						onConnectNetwork={onConnectNetwork ? connectThis : undefined}
						onDisconnectNetwork={(network) => void networkActions.disconnect(network)}
					/>
				</div>
			</div>
			{#if actions.actionError}
				<p role="alert" class="max-w-64 text-xs text-[#bf616a]">{actions.actionError}</p>
			{/if}
			{#if networkActions.failure}
				<p role="alert" class="max-w-64 text-xs text-[#bf616a]">{networkActions.failure}</p>
			{/if}
		</div>
	</div>

	<!-- Card Services Grid: cards have room, so services stay one click away. -->
	<div class="flex-grow p-4 sm:p-5">
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
					containerId={container.id}
					{serviceProxyEnabled}
				/>
			{/each}
		</div>
	</div>
</div>
