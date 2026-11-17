<script lang="ts">
	import { onDestroy } from 'svelte';
	import { ChevronRight, FolderGit2, Loader2, Play } from 'lucide-svelte';
	import type { ContainerData } from '$lib/types';
	import { ContainerActions, TRANSITION_LABELS } from '$lib/containerActions.svelte';
	import ServiceButton from './ServiceButton.svelte';
	import ServicesMenu from './ServicesMenu.svelte';
	import OpenWithMenu from './OpenWithMenu.svelte';
	import ContainerMoreMenu from './ContainerMoreMenu.svelte';

	interface Props {
		container: ContainerData;
		vscodeSshHost?: string;
		serviceProxyEnabled?: boolean;
		onRefresh: () => Promise<void>;
		onOpenTerminal?: (id: string, command: string, name: string, cwd: string) => void;
	}

	let { container, vscodeSshHost, serviceProxyEnabled, onRefresh, onOpenTerminal }: Props =
		$props();

	// Lifecycle requests and rebuild polling; disposing never cancels a server-side rebuild.
	const actions = new ContainerActions(() => ({
		id: container.id,
		onRefresh,
		rebuildContainer: container,
		onOpenBuild: onOpenTerminal
	}));
	onDestroy(() => actions.dispose());

	const uid = $props.id();
	const detailsId = `devcontainer-details-${uid}`;
	let expanded = $state(false);
	const isRunning = $derived(container.state === 'running');
	const transition = $derived(
		actions.loadingAction ? TRANSITION_LABELS[actions.loadingAction] : ''
	);
	const containerName = $derived(container.name.replace(/^\//, ''));
	const workspaceName = $derived(container.localWorkspacePath?.split('/').filter(Boolean).at(-2));
	const portCount = $derived(Object.keys(container.ports).length);
	/** Paths and labels that the menus act on; unknown values are left out. */
	const details = $derived(
		(
			[
				['Local folder', container.localWorkspacePath],
				['Container folder', container.containerWorkspaceFolder],
				['Config', container.devcontainerConfigFile],
				['Image', container.image]
			] as [string, string | undefined][]
		).filter((entry): entry is [string, string] => Boolean(entry[1]))
	);
	const openTerminal = (id: string, command: string, name: string, cwd: string) =>
		onOpenTerminal?.(id, command, name, cwd);
</script>

<!-- Same skeleton as a local workspace row: chevron, identity, chips, then the action pill. -->
<div
	data-container-id={container.id}
	class="transition-colors duration-300
		{isRunning
		? 'hover:bg-[#eceff4]/50 dark:hover:bg-[#434c5e]/50'
		: 'bg-[#e5e9f0]/50 hover:bg-[#e5e9f0] dark:bg-[#2e3440]/30 dark:hover:bg-[#2e3440]/50'}"
>
	<div class="flex flex-wrap items-center justify-between gap-3 px-5 py-2">
		<div class="flex min-w-0 items-center gap-3">
			<button
				type="button"
				onclick={() => (expanded = !expanded)}
				aria-expanded={expanded}
				aria-controls={expanded ? detailsId : undefined}
				aria-label={`Details: ${container.projectName}`}
				class="shrink-0 rounded p-0.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] dark:text-[#d8dee9]/60 dark:hover:bg-[#434c5e]"
			>
				<ChevronRight size={16} class="transition-transform {expanded ? 'rotate-90' : ''}" />
			</button>
			<span
				aria-hidden="true"
				class="h-2.5 w-2.5 shrink-0 rounded-full
					{transition
					? 'animate-pulse bg-[#ebcb8b]'
					: isRunning
						? 'bg-[#a3be8c] shadow-[0_0_8px_rgba(163,190,140,0.5)]'
						: 'bg-[#4c566a]'}"
			></span>
			<span
				class="truncate font-semibold
					{isRunning ? 'text-[#2e3440] dark:text-[#eceff4]' : 'text-[#4c566a] dark:text-[#d8dee9]/70'}"
				>{container.projectName}</span
			>
			<span class="truncate font-mono text-xs text-[#4c566a] dark:text-[#d8dee9]/50"
				>{containerName}</span
			>
			{#if workspaceName}
				<span
					class="hidden shrink-0 items-center gap-1 rounded-full border border-[#81a1c1]/30 bg-[#81a1c1]/10 px-2 py-0.5 text-xs font-medium text-[#81a1c1] md:flex"
					title={container.localWorkspacePath}
				>
					<FolderGit2 size={10} />
					{workspaceName}
				</span>
			{/if}
		</div>

		<div class="ml-auto flex shrink-0 items-center gap-2">
			{#if transition}
				<span
					role="status"
					class="flex items-center gap-1.5 px-2 text-xs font-medium text-[#ebcb8b]"
					title={actions.loadingAction === 'rebuild'
						? 'Output is available in the build terminal.'
						: undefined}
				>
					<Loader2 size={12} class="animate-spin" />
					{transition}…
				</span>
			{:else if isRunning}
				{#if portCount > 0}
					<ServicesMenu {container} {serviceProxyEnabled} />
				{/if}
			{:else}
				<button
					type="button"
					onclick={() => void actions.run('start')}
					class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium whitespace-nowrap text-[#a3be8c] transition-colors hover:bg-[#e5e9f0] dark:hover:bg-[#434c5e]"
				>
					<Play size={12} class="fill-current" />
					Start
				</button>
			{/if}
			<!-- The same pill as local workspaces: Open with first, then container control. -->
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
				<ContainerMoreMenu {container} {actions} />
			</div>
		</div>
	</div>

	{#if actions.actionError}
		<p role="alert" class="px-5 pb-2 text-right text-xs text-[#bf616a]">{actions.actionError}</p>
	{/if}

	{#if expanded}
		<div
			id={detailsId}
			class="mr-5 mb-3 ml-14 grid gap-3 rounded-lg border border-[#d8dee9] bg-[#f0f4f8] p-3 dark:border-[#4c566a] dark:bg-[#2e3440]"
		>
			{#if portCount > 0}
				<div class="flex flex-wrap gap-2">
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
							containerId={container.id}
							{serviceProxyEnabled}
						/>
					{/each}
				</div>
			{/if}
			<dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
				{#each details as [label, value] (label)}
					<dt class="text-[#4c566a] dark:text-[#d8dee9]/60">{label}</dt>
					<dd class="min-w-0 truncate font-mono text-[#2e3440] dark:text-[#d8dee9]" title={value}>
						{value}
					</dd>
				{/each}
			</dl>
		</div>
	{/if}
</div>
