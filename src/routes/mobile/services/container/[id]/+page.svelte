<script lang="ts">
	/**
	 * One plain Docker service container, laid out like the devcontainer screen: status and
	 * origin lead (Compose stack and owning sandbox), then controls, networks, Brain access,
	 * shells and services. Technical details stay collapsed; destructive actions confirm.
	 * Differences follow the server: no rebuild (the sandbox pulls and builds), networks are
	 * read-only, and Logs takes the OpenCode place because a service has no workspace.
	 */
	import {
		ArrowUpRight,
		BrainCircuit,
		Code,
		Copy,
		FolderGit2,
		Globe,
		Layers,
		Loader2,
		Play,
		RotateCw,
		ScrollText,
		Server,
		Square,
		SquareTerminal,
		Tag,
		Trash2
	} from 'lucide-svelte';
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { formatRemaining, useBrainAccess } from '$lib/brainAccess.svelte';
	import { ContainerActions, TRANSITION_LABELS } from '$lib/containerActions.svelte';
	import {
		bareContainerName,
		serviceLogsCommand,
		serviceShellCommand
	} from '$lib/containerOpenTargets';
	import { DEFAULT_NETWORKS } from '$lib/networkRules';
	import { useMobileDashboard, workspaceKey } from '$lib/mobile/dashboard.svelte';
	import { portEntries, tcpAddress, type PortEntry } from '$lib/mobile/ports';
	import { openMobileService } from '$lib/mobile/serviceOpen';
	import { sandboxOwner } from '$lib/mobile/serviceContext';
	import { buildContainerVscodeUri } from '$lib/vscode';
	import BrainAccessDialog from '$lib/components/BrainAccessDialog.svelte';
	import MBanner from '$lib/components/mobile/MBanner.svelte';
	import MButton from '$lib/components/mobile/MButton.svelte';
	import MChip from '$lib/components/mobile/MChip.svelte';
	import MConfirm from '$lib/components/mobile/MConfirm.svelte';
	import MContainerNetworks from '$lib/components/mobile/MContainerNetworks.svelte';
	import MCopyRow from '$lib/components/mobile/MCopyRow.svelte';
	import MDot from '$lib/components/mobile/MDot.svelte';
	import MGroup from '$lib/components/mobile/MGroup.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';
	import MRow from '$lib/components/mobile/MRow.svelte';
	import MSheet from '$lib/components/mobile/MSheet.svelte';

	const dashboard = useMobileDashboard();
	const brain = useBrainAccess();
	const container = $derived(dashboard.container(page.params.id ?? ''));
	const actions = new ContainerActions(() => ({
		id: page.params.id ?? '',
		onRefresh: () => dashboard.refreshContainers()
	}));
	onDestroy(() => actions.dispose());

	let sheet = $state<'delete' | null>(null);
	let brainOpen = $state(false);

	const running = $derived(container?.state === 'running');
	const name = $derived(container ? bareContainerName(container) : '');
	const title = $derived(container?.composeService ?? name);
	/** Brain's clock: the countdown moves with each status poll. */
	const now = $derived(brain?.now ?? 0);
	const grant = $derived(container ? brain?.grantFor(container.id) : undefined);
	const ports = $derived(container ? portEntries(container, dashboard.servicePorts) : []);
	const web = $derived(ports.filter((entry) => entry.web));
	const tcp = $derived(ports.filter((entry) => !entry.web));
	const shellCommand = $derived(container ? serviceShellCommand(container) : '');
	const logsCommand = $derived(container ? serviceLogsCommand(container) : '');
	const stack = $derived(
		container?.composeProject
			? dashboard.stacks.find((candidate) => candidate.name === container.composeProject)
			: undefined
	);
	const owner = $derived(sandboxOwner(dashboard.workspaces, container?.composeWorkingDir));
	/** Default Docker networks; the Networks group lists only user-defined ones. */
	const defaultNetworks = $derived(
		(container?.networks ?? []).filter((network) => DEFAULT_NETWORKS.has(network.name))
	);
	const back = $derived(
		container?.composeProject
			? {
					href: resolve('/mobile/services/[stack]', { stack: container.composeProject }),
					label: container.composeProject
				}
			: { href: resolve('/mobile/services'), label: 'Services' }
	);
	const transition = $derived(
		actions.loadingAction ? `${TRANSITION_LABELS[actions.loadingAction]}…` : ''
	);

	/** Start a command for this container and show it full screen. */
	function openCommand(label: string, command: string) {
		if (!container || !command) return;
		const id = dashboard.openTerminal({
			name: label,
			command,
			cwd: container.localWorkspacePath ?? '',
			kind: 'shell'
		});
		void goto(resolve('/mobile/terminals/[id]', { id: id }));
	}

	/** Open a web port in the phone service viewer, inside the app. */
	function openPort(entry: PortEntry) {
		if (!container) return;
		openMobileService({
			containerPort: entry.containerPort,
			hostPort: entry.hostPort,
			label: entry.label,
			containerName: container.name,
			projectName: container.projectName,
			workspacePath: container.localWorkspacePath,
			allPorts: container.ports,
			containerId: container.id,
			serviceProxyEnabled: dashboard.serviceProxyEnabled
		});
	}

	/** Copy a value and say what was copied; the clipboard needs a secure context. */
	async function copy(value: string, what: string) {
		try {
			await navigator.clipboard.writeText(value);
			dashboard.toast(`Copied ${what}`);
		} catch {
			dashboard.toast(`Copy failed: ${value}`);
		}
	}

	/** Run one lifecycle action from the controls. */
	function act(action: 'start' | 'stop' | 'restart') {
		void actions.run(action);
	}

	/** Delete after confirmation, then return to the stack or the Services list. */
	async function confirmDelete() {
		const destination = back.href;
		await actions.run('delete', { confirmed: true });
		if (!actions.actionError) {
			sheet = null;
			dashboard.toast('Container deleted');
			void goto(destination);
		}
	}
</script>

<MNavBar {back} />
{#if !container}
	<p class="px-8 py-12 text-center text-[16px] text-m-dim" data-testid="container-missing">
		This container no longer exists.
	</p>
{:else}
	<div class="px-5 pt-1 pb-5">
		<div class="flex items-center gap-2 text-[15px] text-m-dim" role="status">
			<MDot state={container.state} busy={Boolean(transition)} />
			{transition ||
				(running ? 'Running' : container.state === 'exited' ? 'Stopped' : container.state)}
		</div>
		<h2 class="mt-1 text-[26px] leading-tight font-bold [overflow-wrap:anywhere]">{title}</h2>
		<div
			class="mt-3 overflow-hidden rounded-[14px] border border-m-frost/20 bg-m-frost/10 [&>*+*]:border-t [&>*+*]:border-m-frost/20"
			data-testid="service-context"
		>
			{#if container.composeProject}
				<MRow
					title={container.composeProject}
					subtitle={stack
						? `Compose stack · ${stack.running} of ${stack.containers.length} running`
						: 'Compose stack'}
					mono
					href={resolve('/mobile/services/[stack]', { stack: container.composeProject })}
					testid="service-stack"
				>
					{#snippet icon()}<Layers size={18} />{/snippet}
				</MRow>
				{#if owner}
					<MRow
						title={owner.repo.name}
						subtitle={`Sandbox · ${owner.workspace.name}`}
						mono
						href={resolve('/mobile/workspaces/[workspace]/[repo]/sandbox', {
							workspace: workspaceKey(owner.workspace),
							repo: owner.repo.name
						})}
						testid="service-sandbox"
					>
						{#snippet icon()}<FolderGit2 size={18} />{/snippet}
					</MRow>
				{:else}
					<MRow
						title="Sandbox unknown"
						subtitle={container.composeWorkingDir ?? 'Compose did not record the project folder.'}
						testid="service-sandbox"
					>
						{#snippet icon()}<FolderGit2 size={18} />{/snippet}
					</MRow>
				{/if}
			{:else}
				<MRow title="Standalone container" subtitle="Not part of a Compose stack">
					{#snippet icon()}<Layers size={18} />{/snippet}
				</MRow>
			{/if}
		</div>
		{#if container.sandboxTag || grant}<div class="mt-3 flex flex-wrap gap-1.5">
				{#if container.sandboxTag}<MChip tone="border-m-frost/50 text-m-frost"
						><Tag size={12} />{container.sandboxTag}</MChip
					>{/if}
				{#if grant}<MChip tone="border-m-brain/50 text-m-brain"
						><BrainCircuit size={13} />Brain shell access · {formatRemaining(
							grant.expiresAt,
							now
						)}</MChip
					>{/if}
			</div>{/if}
	</div>
	{#if actions.actionError}<MBanner
			icon={Server}
			tone="bg-m-stop/15 text-m-stop"
			title="Action failed"
			detail={actions.actionError}
		/>{/if}

	<section class="mx-4 mb-6" aria-label="Container controls">
		<h2 class="mb-2 px-1 text-[14px] font-semibold tracking-wide text-m-dim uppercase">
			Container controls
		</h2>
		<div class="grid grid-cols-2 gap-2">
			{#if running}
				<MButton
					tone="plain"
					onclick={() => act('restart')}
					disabled={actions.busy}
					testid="service-restart"><RotateCw size={18} />Restart</MButton
				>
				<MButton
					tone="plain"
					onclick={() => act('stop')}
					disabled={actions.busy}
					testid="service-stop"
					>{#if actions.loadingAction === 'stop'}<Loader2
							size={18}
							class="animate-spin"
						/>{:else}<Square size={18} />{/if}Stop</MButton
				>
			{:else}
				<MButton
					tone="plain"
					onclick={() => act('start')}
					disabled={actions.busy}
					testid="service-start"
					>{#if actions.loadingAction === 'start'}<Loader2
							size={18}
							class="animate-spin"
						/>{:else}<Play size={18} />{/if}Start</MButton
				>
				<MButton tone="plain" onclick={() => act('restart')} disabled>
					<RotateCw size={18} />Restart</MButton
				>
			{/if}
			<div class="col-span-2">
				<MButton
					tone="danger"
					onclick={() => (sheet = 'delete')}
					disabled={actions.busy}
					testid="service-delete"><Trash2 size={18} />Delete…</MButton
				>
			</div>
		</div>
		<p class="mt-2 px-1 text-[14px] text-m-dim">
			{owner
				? 'Pull, build and versions live in the sandbox.'
				: 'DevHarbour does not rebuild plain Docker containers.'}
		</p>
	</section>

	{#key container.id}<MContainerNetworks {container} readonly />{/key}

	{#if brain?.enabled}
		<MGroup title="Access"
			><MRow
				title="Brain shell access"
				subtitle={grant
					? `${formatRemaining(grant.expiresAt, now)} · revoke or change`
					: 'Review access before granting'}
				tone="bg-m-brain/15 text-m-brain"
				onclick={() => (brainOpen = true)}
				chevron>{#snippet icon()}<BrainCircuit size={18} />{/snippet}</MRow
			></MGroup
		>
	{/if}

	<section class="mx-4 mb-6" aria-label="Shell">
		<h2 class="mb-2 px-1 text-[14px] font-semibold tracking-wide text-m-dim uppercase">Open</h2>
		<div class="grid grid-cols-2 gap-2">
			<MButton
				onclick={() => openCommand(title, shellCommand)}
				disabled={!running}
				testid="service-terminal"><SquareTerminal size={18} />Terminal</MButton
			>
			<MButton
				tone="plain"
				onclick={() => openCommand(`${title} · Logs`, logsCommand)}
				testid="service-logs"><ScrollText size={18} />Logs</MButton
			>
		</div>
		{#if !running}<p class="mt-2 px-1 text-[14px] text-m-dim">
				Start the container to open shells and services. Logs stay available.
			</p>{/if}
	</section>
	{#if running}
		<MGroup title="Services and editors">
			{#each web as entry (entry.containerPort)}
				<MRow
					title={entry.label}
					subtitle={`Port ${entry.containerPort} · opens in DevHarbour`}
					tone="bg-m-frost/15 text-m-frost"
					onclick={() => openPort(entry)}
					>{#snippet icon()}<Globe size={18} />{/snippet}{#snippet trailing()}<ArrowUpRight
							size={18}
							class="shrink-0 text-m-dim"
						/>{/snippet}</MRow
				>
			{/each}
			<MRow
				title="Copy VS Code link"
				subtitle="Attach on your computer"
				tone="bg-m-glacier/15 text-m-glacier"
				onclick={() =>
					void copy(
						buildContainerVscodeUri(container, dashboard.vscodeSshHost),
						'the VS Code link'
					)}
			>
				{#snippet icon()}<Code size={18} />{/snippet}{#snippet trailing()}<Copy
						size={17}
						class="shrink-0 text-m-frost"
					/>{/snippet}
			</MRow>
		</MGroup>
	{/if}
	<details class="mb-6" data-testid="service-details">
		<summary
			class="mx-4 mb-3 flex min-h-14 cursor-pointer items-center gap-3 rounded-[14px] bg-m-surface px-4 text-[17px] font-semibold"
			><Server size={18} class="text-m-dim" />Technical details</summary
		>

		<MGroup>
			<MCopyRow label="Container name" value={name} />
			<MCopyRow label="Image" value={container.image} />
			{#if container.composeService}
				<MCopyRow label="Compose service" value={container.composeService} />
			{/if}
			{#if container.composeWorkingDir}
				<MCopyRow label="Compose folder" value={container.composeWorkingDir} />
			{/if}
			<MCopyRow label="Shell command" value={shellCommand} />
			{#each defaultNetworks as network (network.name)}
				<MCopyRow
					label={`Network ${network.name}`}
					value={network.ip || network.configuredIp || 'No address'}
				/>
			{/each}
		</MGroup>

		{#if tcp.length}
			<MGroup title="Other ports" footer="Tap to copy the address that a client connects to.">
				{#each tcp as entry (`${entry.containerPort}/${entry.port.protocol}`)}
					{@const address = tcpAddress(entry, page.url.hostname)}
					<MRow
						title={address}
						subtitle={`${entry.label} · ${entry.containerPort}/${entry.port.protocol}`}
						mono
						onclick={() => void copy(address, address)}
					>
						{#snippet trailing()}<Copy size={17} class="shrink-0 text-m-frost" />{/snippet}
					</MRow>
				{/each}
			</MGroup>
		{/if}
	</details>

	<MSheet open={sheet === 'delete'} title="Delete" onClose={() => (sheet = null)}>
		<MConfirm
			title={`Delete ${name}?`}
			body={owner
				? 'The container is removed. This cannot be undone. Start the sandbox again to create it.'
				: 'The container is removed. This cannot be undone.'}
			action="Delete container"
			keeps={['Images and volumes']}
			busy={actions.loadingAction === 'delete'}
			error={actions.actionError}
			onConfirm={() => void confirmDelete()}
			onCancel={() => (sheet = null)}
		/>
	</MSheet>

	{#if brainOpen && brain}
		<BrainAccessDialog access={brain} {container} {grant} onClose={() => (brainOpen = false)} />
	{/if}
{/if}
