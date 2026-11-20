<script lang="ts">
	/**
	 * One devcontainer: what it serves, how to get a shell in it, and where it lives.
	 * Lifecycle actions are one level down in the actions sheet; destructive ones confirm.
	 */
	import {
		ArrowUpRight,
		Bot,
		BrainCircuit,
		Code,
		Copy,
		FolderGit2,
		Globe,
		Hammer,
		Loader2,
		Network,
		Play,
		RotateCw,
		Server,
		Square,
		SquareTerminal,
		Trash2
	} from 'lucide-svelte';
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { formatRemaining, useBrainAccess } from '$lib/brainAccess.svelte';
	import { ContainerActions, TRANSITION_LABELS } from '$lib/containerActions.svelte';
	import {
		containerOpenCodeBlocker,
		containerOpenCodeCommand,
		containerShellBlocker,
		containerShellCommand
	} from '$lib/containerOpenTargets';
	import { useMobileDashboard, workspaceKey } from '$lib/mobile/dashboard.svelte';
	import { portEntries, tcpAddress, type PortEntry } from '$lib/mobile/ports';
	import { openContainerService } from '$lib/serviceLaunch';
	import { buildContainerVscodeUri } from '$lib/vscode';
	import BrainAccessDialog from '$lib/components/BrainAccessDialog.svelte';
	import MBanner from '$lib/components/mobile/MBanner.svelte';
	import MButton from '$lib/components/mobile/MButton.svelte';
	import MChip from '$lib/components/mobile/MChip.svelte';
	import MConfirm from '$lib/components/mobile/MConfirm.svelte';
	import MCopyRow from '$lib/components/mobile/MCopyRow.svelte';
	import MDot from '$lib/components/mobile/MDot.svelte';
	import MGroup from '$lib/components/mobile/MGroup.svelte';
	import MIconButton from '$lib/components/mobile/MIconButton.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';
	import MRow from '$lib/components/mobile/MRow.svelte';
	import MSheet from '$lib/components/mobile/MSheet.svelte';

	const dashboard = useMobileDashboard();
	const brain = useBrainAccess();
	const container = $derived(dashboard.container(page.params.id ?? ''));
	const actions = new ContainerActions(() => ({
		id: page.params.id ?? '',
		onRefresh: () => dashboard.refreshAll(),
		rebuildContainer: container,
		onOpenBuild: (id) => void goto(dashboard.terminalHref(id))
	}));
	onDestroy(() => actions.dispose());

	type Sheet = 'actions' | 'rebuild' | 'delete' | null;
	let sheet = $state<Sheet>(null);
	let brainOpen = $state(false);

	const running = $derived(container?.state === 'running');
	/** Brain's clock: the countdown moves with each status poll. */
	const now = $derived(brain?.now ?? 0);
	const grant = $derived(container ? brain?.grantFor(container.id) : undefined);
	const ports = $derived(container ? portEntries(container, dashboard.servicePorts) : []);
	const web = $derived(ports.filter((entry) => entry.web));
	const tcp = $derived(ports.filter((entry) => !entry.web));
	const shellCommand = $derived(container ? containerShellCommand(container) : null);
	const openCodeCommand = $derived(container ? containerOpenCodeCommand(container) : null);
	const workspace = $derived(dashboard.workspaceOf(container?.localWorkspacePath));
	const repoName = $derived(container?.localWorkspacePath?.split('/').filter(Boolean).pop());
	const transition = $derived(
		actions.loadingAction ? `${TRANSITION_LABELS[actions.loadingAction]}…` : ''
	);

	/** Start a command in the container and show it full screen. */
	function openCommand(name: string, command: string | null) {
		if (!container || !command) return;
		const id = dashboard.openTerminal({
			name,
			command,
			cwd: container.localWorkspacePath ?? '',
			kind: 'shell'
		});
		void goto(dashboard.terminalHref(id));
	}

	/** Open a web port in DevHarbour's service viewer; synchronous, for popup rules. */
	function openPort(entry: PortEntry) {
		if (!container) return;
		openContainerService({
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

	/** Run one lifecycle action from the sheet. */
	function act(action: 'start' | 'stop' | 'restart') {
		sheet = null;
		void actions.run(action);
	}

	async function confirmDelete() {
		await actions.run('delete', { confirmed: true });
		if (!actions.actionError) {
			sheet = null;
			dashboard.toast('Container deleted');
			void goto(resolve('/mobile/containers'));
		}
	}

	function confirmRebuild() {
		sheet = null;
		void actions.rebuild({ confirmed: true });
	}
</script>

<MNavBar back={{ href: resolve('/mobile/containers'), label: 'Containers' }}>
	{#snippet right()}
		{#if container}
			<MIconButton
				label="Container actions"
				onclick={() => (sheet = 'actions')}
				testid="container-actions"
			/>
		{/if}
	{/snippet}
</MNavBar>

{#if !container}
	<p class="px-8 py-12 text-center text-[16px] text-m-dim" data-testid="container-missing">
		This container no longer exists.
	</p>
{:else}
	<div class="px-5 pt-1 pb-5">
		<div class="flex items-center gap-2 text-[15px] text-m-dim">
			<MDot state={container.state} busy={Boolean(transition)} />
			{transition ||
				(running ? 'Running' : container.state === 'exited' ? 'Stopped' : container.state)}
		</div>
		<h2 class="mt-1 text-[26px] leading-tight font-bold [overflow-wrap:anywhere]">
			{container.projectName}
		</h2>
		<div class="mt-1 font-mono text-[14px] [overflow-wrap:anywhere] text-m-dim">
			{container.name.replace(/^\//, '')}{container.remoteUser
				? ` · as ${container.remoteUser}`
				: ''}
		</div>
		{#if grant}
			<div class="mt-3">
				<MChip tone="border-m-brain/50 text-m-brain"
					><BrainCircuit size={13} />Brain shell access · {formatRemaining(
						grant.expiresAt,
						now
					)}</MChip
				>
			</div>
		{/if}
	</div>

	{#if actions.actionError}
		<MBanner
			icon={Server}
			tone="bg-m-stop/15 text-m-stop"
			title="Action failed"
			detail={actions.actionError}
		/>
	{/if}
	{#if container.remoteUserError}
		<MBanner
			icon={Server}
			tone="bg-m-beak/15 text-m-beak"
			title="Shells are unavailable"
			detail={container.remoteUserError}
		/>
	{/if}

	{#if running}
		{#if web.length}
			<MGroup title="Open">
				{#each web as entry (entry.containerPort)}
					<MRow
						title={entry.label}
						subtitle={`Port ${entry.containerPort} · opens in DevHarbour`}
						tone="bg-m-frost/15 text-m-frost"
						onclick={() => openPort(entry)}
					>
						{#snippet icon()}<Globe size={18} />{/snippet}
						{#snippet trailing()}<ArrowUpRight size={18} class="shrink-0 text-m-dim" />{/snippet}
					</MRow>
				{/each}
			</MGroup>
		{/if}
		<MGroup title="Shell">
			<MRow
				title="Terminal"
				subtitle={containerShellBlocker(container) ??
					container.containerWorkspaceFolder ??
					'Login shell'}
				disabled={!shellCommand}
				onclick={() => openCommand(container.projectName, shellCommand)}
				chevron
				testid="container-terminal"
			>
				{#snippet icon()}<SquareTerminal size={18} />{/snippet}
			</MRow>
			<MRow
				title="OpenCode TUI"
				subtitle={containerOpenCodeBlocker(container) ?? 'Opens in a terminal'}
				tone="bg-m-brain/15 text-m-brain"
				disabled={!openCodeCommand}
				onclick={() => openCommand(`${container.projectName} · OpenCode`, openCodeCommand)}
				chevron
			>
				{#snippet icon()}<Bot size={18} />{/snippet}
			</MRow>
			<MRow
				title="Copy VS Code link"
				subtitle="Open it on your computer"
				tone="bg-m-glacier/15 text-m-glacier"
				onclick={() =>
					void copy(
						buildContainerVscodeUri(container, dashboard.vscodeSshHost),
						'the VS Code link'
					)}
			>
				{#snippet icon()}<Code size={18} />{/snippet}
				{#snippet trailing()}<Copy size={17} class="shrink-0 text-m-frost" />{/snippet}
			</MRow>
		</MGroup>
	{:else}
		<div class="mx-4 mb-6 grid gap-2">
			<MButton
				onclick={() => void actions.run('start')}
				disabled={actions.busy}
				testid="container-start"
			>
				{#if actions.loadingAction === 'start'}<Loader2
						size={18}
						class="animate-spin"
					/>{:else}<Play size={18} class="fill-current" />{/if}Start container
			</MButton>
			<p class="px-1 text-[14px] text-m-dim">Services and shells open when it runs.</p>
		</div>
	{/if}

	<MGroup title="Details">
		{#if container.localWorkspacePath}
			<MCopyRow label="Local folder" value={container.localWorkspacePath} />
		{/if}
		{#if container.containerWorkspaceFolder}
			<MCopyRow label="Container folder" value={container.containerWorkspaceFolder} />
		{/if}
		{#if container.devcontainerConfigFile}
			<MCopyRow label="Config" value={container.devcontainerConfigFile} />
		{/if}
		<MCopyRow label="Image" value={container.image} />
		{#if workspace && repoName}
			<MRow
				title="Repository"
				subtitle={`${workspace.name} › ${repoName}`}
				href={resolve('/mobile/workspaces/[workspace]/[repo]', {
					workspace: workspaceKey(workspace),
					repo: repoName
				})}
			>
				{#snippet icon()}<FolderGit2 size={18} />{/snippet}
			</MRow>
		{/if}
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

	{#if container.networks?.length}
		<MGroup title="Networks" footer="Connect to other networks from the desktop dashboard.">
			{#each container.networks as network (network.name)}
				<MRow
					title={network.name}
					subtitle={[network.ip || network.configuredIp, ...network.aliases]
						.filter(Boolean)
						.join(' · ') || 'No address'}
					tone="bg-m-glacier/15 text-m-glacier"
				>
					{#snippet icon()}<Network size={18} />{/snippet}
				</MRow>
			{/each}
		</MGroup>
	{/if}

	<MSheet
		open={sheet === 'actions'}
		title={container.projectName}
		onClose={() => (sheet = null)}
		testid="container-actions-sheet"
	>
		<MGroup>
			{#if running}
				<MRow title="Restart" onclick={() => act('restart')} disabled={actions.busy}>
					{#snippet icon()}<RotateCw size={18} />{/snippet}
				</MRow>
				<MRow title="Stop" onclick={() => act('stop')} disabled={actions.busy}>
					{#snippet icon()}<Square size={16} />{/snippet}
				</MRow>
			{:else}
				<MRow title="Start" onclick={() => act('start')} disabled={actions.busy}>
					{#snippet icon()}<Play size={18} />{/snippet}
				</MRow>
			{/if}
			<MRow
				title="Rebuild and restart…"
				subtitle={actions.canRebuild ? undefined : 'The build labels of this container are missing'}
				tone="bg-m-warn/15 text-m-warn"
				onclick={() => (sheet = 'rebuild')}
				disabled={!actions.canRebuild || actions.busy}
				chevron
			>
				{#snippet icon()}<Hammer size={18} />{/snippet}
			</MRow>
		</MGroup>
		{#if brain?.enabled}
			<MGroup>
				<MRow
					title={grant ? 'Brain access' : 'Give Brain shell access…'}
					subtitle={grant
						? `${formatRemaining(grant.expiresAt, now)} · revoke or change`
						: undefined}
					tone="bg-m-brain/15 text-m-brain"
					onclick={() => {
						sheet = null;
						brainOpen = true;
					}}
					chevron
				>
					{#snippet icon()}<BrainCircuit size={18} />{/snippet}
				</MRow>
			</MGroup>
		{/if}
		<MGroup>
			<MRow
				title="Delete container…"
				danger
				tone="bg-m-stop/15 text-m-stop"
				onclick={() => (sheet = 'delete')}
				disabled={actions.busy}
				chevron
			>
				{#snippet icon()}<Trash2 size={18} />{/snippet}
			</MRow>
		</MGroup>
	</MSheet>

	<MSheet open={sheet === 'rebuild'} title="Rebuild" onClose={() => (sheet = null)}>
		<MConfirm
			title={`Rebuild ${container.projectName}?`}
			body="DevHarbour builds the configuration again and replaces this container. Its services and terminals stop, and changes outside mounted folders are lost. There is no automatic rollback."
			action="Rebuild and restart"
			tone="warn"
			keeps={['Workspace files on the host', 'Named volumes']}
			onConfirm={confirmRebuild}
			onCancel={() => (sheet = null)}
		/>
	</MSheet>

	<MSheet open={sheet === 'delete'} title="Delete" onClose={() => (sheet = null)}>
		<MConfirm
			title={`Delete ${container.name.replace(/^\//, '')}?`}
			body="The container is removed. This cannot be undone. You can build it again from its repository."
			action="Delete container"
			keeps={['Source files on the host', 'Images and volumes']}
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
