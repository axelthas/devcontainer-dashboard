<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Check, ChevronRight, Copy, FolderGit2, Loader2, Play, Plus } from 'lucide-svelte';
	import type { ContainerData } from '$lib/types';
	import { ContainerActions, TRANSITION_LABELS } from '$lib/containerActions.svelte';
	import { getPortLabel } from '$lib/portConfig';
	import {
		containerOpenCodeBlocker,
		containerOpenCodeCommand,
		containerShellBlocker,
		containerShellCommand
	} from '$lib/containerOpenTargets';
	import { DEFAULT_NETWORKS } from '$lib/networkRules';
	import { NetworkActions } from '$lib/networkActions.svelte';
	import ServicesMenu from './ServicesMenu.svelte';
	import NetworkChips from './NetworkChips.svelte';
	import OpenWithMenu from './OpenWithMenu.svelte';
	import ContainerMoreMenu from './ContainerMoreMenu.svelte';

	interface Props {
		container: ContainerData;
		vscodeSshHost?: string;
		serviceProxyEnabled?: boolean;
		onRefresh: () => Promise<void>;
		onOpenTerminal?: (id: string, command: string, name: string, cwd: string) => void;
		/** Open the network drawer for this container, optionally on a network and a seat */
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
	// Network disconnect and reconnect, shared by the chips and the ⋯ menu.
	const networkActions = new NetworkActions(() => ({
		container,
		onRefresh,
		onConnectNetwork
	}));
	onDestroy(() => {
		actions.dispose();
		clearTimeout(copyTimer);
	});

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
	/** Published ports, sorted by container port: container port → host port. */
	const portMappings = $derived(
		Object.entries(container.ports)
			.map(([containerPort, hostPort]) => ({
				containerPort,
				hostPort,
				label: getPortLabel(containerPort)
			}))
			.sort((a, b) => Number(a.containerPort) - Number(b.containerPort))
	);
	/** The exact commands that Open with runs in the terminal drawer, or why it cannot. */
	const commands = $derived([
		{
			label: 'Terminal command',
			command: containerShellCommand(container),
			blocker: containerShellBlocker(container)
		},
		{
			label: 'OpenCode TUI command',
			command: containerOpenCodeCommand(container),
			blocker: containerOpenCodeBlocker(container)
		}
	]);

	let copied = $state('');
	let copyError = $state('');
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	/** Copy a command. The clipboard API needs a secure context, so a failure is reported. */
	async function copyCommand(label: string, command: string) {
		clearTimeout(copyTimer);
		copyError = '';
		try {
			await navigator.clipboard.writeText(command);
			copied = label;
		} catch {
			copied = '';
			copyError = 'Copy failed: select the command and copy it manually.';
		}
		copyTimer = setTimeout(() => {
			copied = '';
			copyError = '';
		}, 2000);
	}

	/** Open the network drawer on this container. */
	const connectThis = () => onConnectNetwork?.(container);
	/** Every network of the container, default networks included, for the details. */
	const networkRows = $derived(
		(container.networks ?? []).map((network) => ({
			...network,
			address: network.ip || network.configuredIp || '',
			isDefault: DEFAULT_NETWORKS.has(network.name)
		}))
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
			{#if !transition}
				<NetworkChips {container} actions={networkActions} {onConnectNetwork} />
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
				<ContainerMoreMenu
					{container}
					{actions}
					onConnectNetwork={onConnectNetwork ? connectThis : undefined}
					onDisconnectNetwork={(network) => void networkActions.disconnect(network)}
				/>
			</div>
		</div>
	</div>

	{#if actions.actionError}
		<p role="alert" class="px-5 pb-2 text-right text-xs text-[#bf616a]">{actions.actionError}</p>
	{/if}
	{#if networkActions.failure}
		<p role="alert" class="px-5 pb-2 text-right text-xs text-[#bf616a]">
			{networkActions.failure}
		</p>
	{/if}

	{#if expanded}
		<div
			id={detailsId}
			class="mr-5 mb-3 ml-14 grid gap-3 rounded-lg border border-[#d8dee9] bg-[#f0f4f8] p-3 dark:border-[#4c566a] dark:bg-[#2e3440]"
		>
			<dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
				{#each details as [label, value] (label)}
					<dt class="text-[#4c566a] dark:text-[#d8dee9]/60">{label}</dt>
					<dd class="min-w-0 truncate font-mono text-[#2e3440] dark:text-[#d8dee9]" title={value}>
						{value}
					</dd>
				{/each}

				<dt class="text-[#4c566a] dark:text-[#d8dee9]/60">Remote user</dt>
				<dd class="min-w-0">
					{#if container.remoteUserError}
						<span class="text-[#bf616a]">{container.remoteUserError}</span>
					{:else if container.remoteUser}
						<span class="font-mono text-[#2e3440] dark:text-[#d8dee9]">{container.remoteUser}</span>
						<span class="text-[#4c566a] dark:text-[#d8dee9]/60"
							>from {container.remoteUserSource ?? 'remoteUser'} in the devcontainer metadata</span
						>
					{:else}
						<span class="text-[#2e3440] dark:text-[#d8dee9]">Container default user</span>
						<span class="text-[#4c566a] dark:text-[#d8dee9]/60"
							>no remoteUser or containerUser in the devcontainer metadata</span
						>
					{/if}
				</dd>

				<dt class="text-[#4c566a] dark:text-[#d8dee9]/60">Ports</dt>
				<dd class="min-w-0">
					{#if portMappings.length > 0}
						<ul aria-label="Port mapping" class="grid gap-0.5">
							{#each portMappings as port (port.containerPort)}
								<li class="flex gap-2">
									<span class="w-24 shrink-0 truncate text-[#4c566a] dark:text-[#d8dee9]/60"
										>{port.label}</span
									>
									<span class="font-mono text-[#2e3440] dark:text-[#d8dee9]"
										>{port.containerPort} → host {port.hostPort}</span
									>
								</li>
							{/each}
						</ul>
					{:else}
						<span class="text-[#4c566a] dark:text-[#d8dee9]/60">No published ports</span>
					{/if}
				</dd>

				<dt class="text-[#4c566a] dark:text-[#d8dee9]/60">Networks</dt>
				<dd class="flex min-w-0 flex-wrap items-start justify-between gap-2">
					{#if networkRows.length > 0}
						<ul aria-label="Networks" class="grid min-w-0 gap-0.5">
							{#each networkRows as network (network.name)}
								<li class="flex flex-wrap gap-x-2">
									<span
										class="font-mono break-all {network.isDefault
											? 'text-[#4c566a] dark:text-[#d8dee9]/60'
											: 'text-[#4f8584] dark:text-[#8fbcbb]'}">{network.name}</span
									>
									<span class="font-mono text-[#2e3440] dark:text-[#d8dee9]"
										>{network.address || 'no address while stopped'}</span
									>
									{#if network.aliases.length > 0}
										<span class="text-[#4c566a] dark:text-[#d8dee9]/60"
											>alias <span class="font-mono">{network.aliases.join(', ')}</span></span
										>
									{/if}
								</li>
							{/each}
						</ul>
					{:else}
						<span class="text-[#4c566a] dark:text-[#d8dee9]/60">No networks reported</span>
					{/if}
					{#if onConnectNetwork}
						<button
							type="button"
							disabled={!isRunning}
							title={isRunning ? undefined : 'Start the container to connect a network'}
							onclick={() => onConnectNetwork?.(container)}
							class="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-[#4f8584] transition-colors hover:bg-[#e5e9f0] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#8fbcbb] dark:hover:bg-[#434c5e]"
						>
							<Plus size={12} />Connect…
						</button>
					{/if}
				</dd>

				{#each commands as entry (entry.label)}
					<dt class="text-[#4c566a] dark:text-[#d8dee9]/60">{entry.label}</dt>
					<dd class="flex min-w-0 items-start gap-2">
						{#if entry.command}
							<code
								class="min-w-0 flex-1 font-mono break-all whitespace-pre-wrap text-[#2e3440] dark:text-[#d8dee9]"
								>{entry.command}</code
							>
							<button
								type="button"
								aria-label={`Copy ${entry.label}`}
								title={`Copy ${entry.label}`}
								onclick={() => void copyCommand(entry.label, entry.command ?? '')}
								class="shrink-0 rounded p-0.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] dark:text-[#d8dee9]/60 dark:hover:bg-[#434c5e]"
							>
								{#if copied === entry.label}
									<Check size={13} class="text-[#a3be8c]" />
								{:else}
									<Copy size={13} />
								{/if}
							</button>
						{:else}
							<span class="text-[#4c566a] dark:text-[#d8dee9]/60">{entry.blocker}</span>
						{/if}
					</dd>
				{/each}
			</dl>
			{#if !isRunning}
				<p class="text-xs text-[#4c566a] dark:text-[#d8dee9]/60">
					The commands run when the container is running. While it is stopped, Open with opens
					the host folder.
				</p>
			{/if}
			{#if copyError}
				<p role="alert" class="text-xs text-[#bf616a]">{copyError}</p>
			{/if}
		</div>
	{/if}
</div>
