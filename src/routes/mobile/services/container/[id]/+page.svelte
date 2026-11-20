<script lang="ts">
	/** One Docker service container: start or stop it, open its ports, and get a shell. */
	import {
		ArrowUpRight,
		Copy,
		Globe,
		Loader2,
		Network,
		Play,
		RotateCw,
		Server,
		Square,
		SquareTerminal,
		Trash2,
		TriangleAlert
	} from 'lucide-svelte';
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { ContainerActions, TRANSITION_LABELS } from '$lib/containerActions.svelte';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';
	import { portEntries, tcpAddress, type PortEntry } from '$lib/mobile/ports';
	import { openContainerService } from '$lib/serviceLaunch';
	import MBanner from '$lib/components/mobile/MBanner.svelte';
	import MButton from '$lib/components/mobile/MButton.svelte';
	import MConfirm from '$lib/components/mobile/MConfirm.svelte';
	import MCopyRow from '$lib/components/mobile/MCopyRow.svelte';
	import MDot from '$lib/components/mobile/MDot.svelte';
	import MGroup from '$lib/components/mobile/MGroup.svelte';
	import MIconButton from '$lib/components/mobile/MIconButton.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';
	import MRow from '$lib/components/mobile/MRow.svelte';
	import MSheet from '$lib/components/mobile/MSheet.svelte';

	const dashboard = useMobileDashboard();
	const container = $derived(dashboard.container(page.params.id ?? ''));
	const actions = new ContainerActions(() => ({
		id: page.params.id ?? '',
		onRefresh: () => dashboard.refreshContainers()
	}));
	onDestroy(() => actions.dispose());
	let sheet = $state<'actions' | 'delete' | null>(null);

	const running = $derived(container?.state === 'running');
	const name = $derived(container?.name.replace(/^\//, '') ?? '');
	const ports = $derived(container ? portEntries(container, dashboard.servicePorts) : []);
	const web = $derived(ports.filter((entry) => entry.web));
	const tcp = $derived(ports.filter((entry) => !entry.web));
	/** The same shell command as the desktop Open with menu for plain Docker containers. */
	const shell = $derived(`docker exec -it ${name} bash || docker exec -it ${name} sh`);
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

	async function copy(value: string, what: string) {
		try {
			await navigator.clipboard.writeText(value);
			dashboard.toast(`Copied ${what}`);
		} catch {
			dashboard.toast(`Copy failed: ${value}`);
		}
	}

	function openShell() {
		if (!container) return;
		const id = dashboard.openTerminal({
			name: container.composeService ?? name,
			command: shell,
			cwd: container.localWorkspacePath ?? '',
			kind: 'shell'
		});
		void goto(resolve('/mobile/terminals/[id]', { id: id }));
	}

	async function confirmDelete() {
		await actions.run('delete', { confirmed: true });
		if (!actions.actionError) {
			sheet = null;
			dashboard.toast('Container deleted');
			void goto(
				container?.composeProject
					? resolve('/mobile/services/[stack]', { stack: container.composeProject })
					: resolve('/mobile/services')
			);
		}
	}
</script>

<MNavBar {back}>
	{#snippet right()}
		{#if container}<MIconButton label="Service actions" onclick={() => (sheet = 'actions')} />{/if}
	{/snippet}
</MNavBar>

{#if !container}
	<p class="px-8 py-12 text-center text-[16px] text-m-dim">This container no longer exists.</p>
{:else}
	<div class="px-5 pb-5">
		<div class="flex items-center gap-2 text-[15px] text-m-dim">
			<MDot state={container.state} busy={Boolean(transition)} />{transition ||
				(running ? 'Running' : 'Stopped')}
		</div>
		<h2 class="mt-1 text-[26px] leading-tight font-bold [overflow-wrap:anywhere]">
			{container.composeService ?? name}
		</h2>
		<div class="mt-1 font-mono text-[14px] [overflow-wrap:anywhere] text-m-dim">
			{container.image}
		</div>
	</div>
	{#if actions.actionError}
		<MBanner
			icon={TriangleAlert}
			tone="bg-m-stop/15 text-m-stop"
			title="Action failed"
			detail={actions.actionError}
		/>
	{/if}
	<div class="mx-4 mb-6">
		{#if running}
			<MButton
				tone="danger"
				onclick={() => void actions.run('stop')}
				disabled={actions.busy}
				testid="service-stop"
			>
				{#if actions.loadingAction === 'stop'}<Loader2
						size={18}
						class="animate-spin"
					/>{:else}<Square size={16} class="fill-current" />{/if}Stop
			</MButton>
		{:else}
			<MButton
				onclick={() => void actions.run('start')}
				disabled={actions.busy}
				testid="service-start"
			>
				{#if actions.loadingAction === 'start'}<Loader2
						size={18}
						class="animate-spin"
					/>{:else}<Play size={18} class="fill-current" />{/if}Start
			</MButton>
		{/if}
	</div>
	{#if web.length}
		<MGroup title="Open" footer={running ? undefined : 'Links work when the service runs.'}>
			{#each web as entry (entry.containerPort)}
				<MRow
					title={entry.label}
					subtitle={`Port ${entry.containerPort} · opens in DevHarbour`}
					tone="bg-m-frost/15 text-m-frost"
					onclick={() => openPort(entry)}
					disabled={!running}
				>
					{#snippet icon()}<Globe size={18} />{/snippet}
					{#snippet trailing()}<ArrowUpRight size={18} class="shrink-0 text-m-dim" />{/snippet}
				</MRow>
			{/each}
		</MGroup>
	{/if}
	{#if tcp.length}
		<MGroup title="Addresses" footer="Tap to copy the address that a client connects to.">
			{#each tcp as entry (`${entry.containerPort}/${entry.port.protocol}`)}
				{@const address = tcpAddress(entry, page.url.hostname)}
				<MRow
					title={address}
					subtitle={`${entry.label} · ${entry.containerPort}/${entry.port.protocol}`}
					mono
					tone="bg-m-raised text-m-dim"
					onclick={() => void copy(address, address)}
				>
					{#snippet icon()}<Server size={18} />{/snippet}
					{#snippet trailing()}<Copy size={17} class="shrink-0 text-m-frost" />{/snippet}
				</MRow>
			{/each}
		</MGroup>
	{/if}
	<MGroup title="Shell">
		<MRow
			title="Terminal"
			subtitle={running ? 'docker exec, bash or sh' : 'Start the service first'}
			onclick={openShell}
			disabled={!running}
			chevron
			testid="service-terminal"
		>
			{#snippet icon()}<SquareTerminal size={18} />{/snippet}
		</MRow>
		<MCopyRow label="Command" value={shell} />
	</MGroup>
	{#if container.networks?.length}
		<MGroup title="Networks">
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
		title={container.composeService ?? name}
		onClose={() => (sheet = null)}
	>
		<MGroup>
			<MRow
				title="Restart"
				onclick={() => {
					sheet = null;
					void actions.run('restart');
				}}
				disabled={actions.busy || !running}
			>
				{#snippet icon()}<RotateCw size={18} />{/snippet}
			</MRow>
			<MRow
				title="Copy container name"
				onclick={() => {
					sheet = null;
					void copy(name, 'the container name');
				}}
			>
				{#snippet icon()}<Copy size={18} />{/snippet}
			</MRow>
		</MGroup>
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
	<MSheet open={sheet === 'delete'} title="Delete" onClose={() => (sheet = null)}>
		<MConfirm
			title={`Delete ${name}?`}
			body="The container is removed. This cannot be undone."
			action="Delete container"
			keeps={['Images and volumes']}
			busy={actions.loadingAction === 'delete'}
			error={actions.actionError}
			onConfirm={() => void confirmDelete()}
			onCancel={() => (sheet = null)}
		/>
	</MSheet>
{/if}
