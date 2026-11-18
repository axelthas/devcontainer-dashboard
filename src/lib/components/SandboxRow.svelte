<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Check, ChevronRight, Copy, Globe, Loader2, Play } from 'lucide-svelte';
	import type { ContainerData, ServiceAccess, ServicePortPolicy } from '$lib/types';
	import { generateId } from '$lib/index';
	import { ContainerActions, TRANSITION_LABELS } from '$lib/containerActions.svelte';
	import { containerExposure } from '$lib/publishedPorts';
	import { DEFAULT_NETWORKS } from '$lib/networkRules';
	import SandboxServicesMenu from './SandboxServicesMenu.svelte';
	import SandboxOpenWithMenu from './SandboxOpenWithMenu.svelte';
	import ContainerMoreMenu from './ContainerMoreMenu.svelte';
	import BrainAccessButton from './BrainAccessButton.svelte';
	import PortLedger from './PortLedger.svelte';

	interface Props {
		container: ContainerData;
		vscodeSshHost: string;
		serviceProxyEnabled?: boolean;
		/** Which container ports are web services, and how the dashboard opens them */
		servicePorts?: ServicePortPolicy;
		serviceAccess?: ServiceAccess;
		/** Outside a Compose group there is no group header, so the row labels its own exposure. */
		standalone?: boolean;
		onRefresh: () => Promise<void>;
		onOpenTerminal?: (id: string, command: string, name: string, cwd: string) => void;
	}

	let {
		container,
		vscodeSshHost,
		serviceProxyEnabled,
		servicePorts = {},
		serviceAccess = 'direct',
		standalone = false,
		onRefresh,
		onOpenTerminal
	}: Props = $props();

	// Start, stop, restart and remove. Plain Docker services have no rebuild.
	const actions = new ContainerActions(() => ({ id: container.id, onRefresh }));
	onDestroy(() => {
		actions.dispose();
		clearTimeout(statusTimer);
	});

	const uid = $props.id();
	const detailsId = `sandbox-details-${uid}`;
	let expanded = $state(false);
	const isRunning = $derived(container.state === 'running');
	const transition = $derived(
		actions.loadingAction ? TRANSITION_LABELS[actions.loadingAction] : ''
	);
	const containerName = $derived(container.name.replace(/^\//, ''));
	const portCount = $derived(Object.keys(container.ports).length);
	const exposedToAll = $derived(containerExposure(container.portBindings) === 'all');
	/** The shell command that Open with runs; the same for every plain Docker container. */
	const terminalCommand = $derived(
		`docker exec -it ${containerName} bash || docker exec -it ${containerName} sh`
	);
	/** Every network of the container, default networks included, for the details. */
	const networkRows = $derived(
		(container.networks ?? []).map((network) => ({
			...network,
			address: network.ip || network.configuredIp || '',
			isDefault: DEFAULT_NETWORKS.has(network.name)
		}))
	);

	let status = $state('');
	let statusTimer: ReturnType<typeof setTimeout> | undefined;

	/** Show a short copy result in the row, then clear it. */
	function showStatus(message: string) {
		clearTimeout(statusTimer);
		status = message;
		statusTimer = setTimeout(() => (status = ''), 3000);
	}

	/** Copy the terminal command. The clipboard API needs a secure context. */
	async function copyCommand() {
		try {
			await navigator.clipboard.writeText(terminalCommand);
			showStatus('Copied the terminal command');
		} catch {
			showStatus('Copy failed: select the command and copy it manually.');
		}
	}

	/** Open a shell in the terminal drawer, in the local folder when the container has one. */
	function openTerminal() {
		onOpenTerminal?.(
			generateId(),
			terminalCommand,
			container.projectName,
			container.localWorkspacePath ?? ''
		);
	}
</script>

<!-- Same skeleton as a devcontainer row: chevron, identity, marks, then the action pill. -->
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
			<span
				class="hidden truncate font-mono text-xs text-[#4c566a] sm:inline dark:text-[#d8dee9]/50"
				title={container.name}>{container.image}</span
			>
			{#if exposedToAll}
				{#if standalone}
					<span
						class="flex shrink-0 items-center gap-1 rounded-full border border-[#b48ead]/40 bg-[#b48ead]/10 px-2 py-0.5 text-xs font-medium text-[#b48ead]"
						title="Ports are published on all host interfaces"
					>
						<Globe size={11} />All interfaces
					</span>
				{:else}
					<span title="Ports are published on all host interfaces" class="shrink-0 text-[#b48ead]">
						<Globe size={13} aria-label="Published on all interfaces" />
					</span>
				{/if}
			{/if}
		</div>

		<div class="ml-auto flex shrink-0 items-center gap-2">
			{#if status}
				<span role="status" class="px-2 text-xs text-[#4c566a] dark:text-[#d8dee9]/70"
					>{status}</span
				>
			{/if}
			{#if transition}
				<span
					role="status"
					class="flex items-center gap-1.5 px-2 text-xs font-medium text-[#ebcb8b]"
				>
					<Loader2 size={12} class="animate-spin" />
					{transition}…
				</span>
			{:else if isRunning}
				{#if portCount > 0}
					<SandboxServicesMenu
						{container}
						{serviceProxyEnabled}
						{servicePorts}
						{serviceAccess}
						onCopied={showStatus}
					/>
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
			{#if !transition}
				<BrainAccessButton {container} />
			{/if}
			<div
				class="flex items-center rounded-xl border border-[#d8dee9] bg-[#eceff4] p-1 shadow-sm dark:border-[#434c5e] dark:bg-[#2e3440]"
			>
				<SandboxOpenWithMenu
					{container}
					{vscodeSshHost}
					disabled={Boolean(transition)}
					onOpenTerminal={onOpenTerminal ? openTerminal : undefined}
				/>
				<div class="mx-0.5 h-4 w-px shrink-0 bg-[#d8dee9] dark:bg-[#434c5e]"></div>
				<ContainerMoreMenu {container} {actions} rebuild={false} />
			</div>
		</div>
	</div>

	{#if actions.actionError}
		<p role="alert" class="px-5 pb-2 text-right text-xs text-[#bf616a]">{actions.actionError}</p>
	{/if}

	{#if expanded}
		<div
			id={detailsId}
			class="mr-5 mb-3 ml-14 grid gap-3 rounded-lg border border-[#d8dee9] bg-[#f0f4f8] p-3 text-xs dark:border-[#4c566a] dark:bg-[#2e3440]"
		>
			<dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
				<dt class="text-[#4c566a] dark:text-[#d8dee9]/60">Container</dt>
				<dd class="min-w-0 truncate font-mono text-[#2e3440] dark:text-[#d8dee9]">
					{containerName}
				</dd>

				<dt class="text-[#4c566a] dark:text-[#d8dee9]/60">Image</dt>
				<dd
					class="min-w-0 truncate font-mono text-[#2e3440] dark:text-[#d8dee9]"
					title={container.image}
				>
					{container.image}
				</dd>

				<dt class="text-[#4c566a] dark:text-[#d8dee9]/60">Published</dt>
				<dd class="min-w-0">
					<PortLedger
						bindings={container.portBindings}
						{servicePorts}
						{serviceAccess}
						running={isRunning}
					/>
				</dd>

				<dt class="text-[#4c566a] dark:text-[#d8dee9]/60">Networks</dt>
				<dd class="min-w-0">
					{#if networkRows.length > 0}
						<ul aria-label="Networks" class="grid gap-0.5">
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
				</dd>

				<dt class="text-[#4c566a] dark:text-[#d8dee9]/60">Terminal command</dt>
				<dd class="flex min-w-0 items-start gap-2">
					<code
						class="min-w-0 flex-1 font-mono break-all whitespace-pre-wrap text-[#2e3440] dark:text-[#d8dee9]"
						>{terminalCommand}</code
					>
					<button
						type="button"
						aria-label="Copy Terminal command"
						title="Copy Terminal command"
						onclick={() => void copyCommand()}
						class="shrink-0 rounded p-0.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] dark:text-[#d8dee9]/60 dark:hover:bg-[#434c5e]"
					>
						{#if status === 'Copied the terminal command'}
							<Check size={13} class="text-[#a3be8c]" />
						{:else}
							<Copy size={13} />
						{/if}
					</button>
				</dd>
			</dl>
		</div>
	{/if}
</div>
