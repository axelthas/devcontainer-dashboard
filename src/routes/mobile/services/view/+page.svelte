<script lang="ts">
	/**
	 * Phone service viewer: a container web service as a DevHarbour screen, not a new page.
	 *
	 * - The header fills the status-bar area with a solid colour, so the iOS top edge has
	 *   nothing to blur. It holds Back, the service and its workspace, and one menu.
	 * - The service area ends at the on-screen keyboard (visual viewport), so a composer at
	 *   the bottom of the service stays in view.
	 * - Services opened here stay loaded while you switch, up to MAX_LOADED_SERVICES.
	 * - The server contract is the desktop contract; services that cannot be embedded say so
	 *   and offer Safari.
	 */
	import {
		Check,
		ChevronDown,
		ChevronLeft,
		Copy,
		ExternalLink,
		FolderGit2,
		Globe,
		Loader2,
		MoreHorizontal,
		RotateCw,
		Server
	} from 'lucide-svelte';
	import { afterNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';
	import { portEntries } from '$lib/mobile/ports';
	import {
		CONTAINER_REF,
		keepLoaded,
		MAX_LOADED_SERVICES,
		mobileServiceHref,
		reloadLoaded,
		type LoadedService
	} from '$lib/mobile/serviceView';
	import { unavailableText, type ViewerContract } from '$lib/serviceViewer';
	import { visualViewportState } from '$lib/visualViewport.svelte';
	import MDot from '$lib/components/mobile/MDot.svelte';
	import MGroup from '$lib/components/mobile/MGroup.svelte';
	import MRow from '$lib/components/mobile/MRow.svelte';
	import MSheet from '$lib/components/mobile/MSheet.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const dashboard = useMobileDashboard();

	const viewer = $derived(data.viewer as ViewerContract);
	const containerId = $derived(
		viewer.containerId ?? data.containerId ?? page.url.searchParams.get(CONTAINER_REF) ?? ''
	);
	const containerPort = $derived(viewer.containerPort ?? data.containerPort ?? '');
	const container = $derived(containerId ? dashboard.container(containerId) : undefined);
	const workspacePath = $derived(data.workspacePath || container?.localWorkspacePath || '');
	const workspace = $derived(dashboard.workspaceOf(workspacePath || undefined));
	const project = $derived(data.project || container?.projectName || data.container || '');
	const context = $derived(
		[project, workspace?.name ?? workspacePath.split('/').filter(Boolean).at(-2)]
			.filter(Boolean)
			.join(' · ')
	);
	const services = $derived(
		container ? portEntries(container, dashboard.servicePorts).filter((entry) => entry.web) : []
	);
	const embeddable = $derived(
		(viewer.kind === 'proxy' || viewer.kind === 'legacy') && Boolean(viewer.target)
	);
	/** Identity of the shown service; legacy links without a container use their URL. */
	const currentId = $derived(
		containerId && containerPort ? `${containerId}:${containerPort}` : (viewer.target ?? data.label)
	);

	let loaded = $state<LoadedService[]>([]);
	/** `id#generation` of pages whose load event fired. */
	let ready = $state<Record<string, true>>({});
	let sheet = $state<'services' | 'more' | null>(null);
	let cameFromApp = false;
	let first = true;

	/** Every navigation, including switches with replaceState, shows the requested service. */
	afterNavigate(({ from }) => {
		if (first) {
			cameFromApp = Boolean(from);
			first = false;
		}
		sheet = null;
		if (embeddable && viewer.target)
			loaded = keepLoaded(loaded, { id: currentId, src: viewer.target, title: data.label });
	});

	const frameKey = (entry: LoadedService) => `${entry.id}#${entry.generation}`;
	const current = $derived(loaded.find((entry) => entry.id === currentId));
	const loading = $derived(embeddable && (!current || !ready[frameKey(current)]));

	/** Where Back goes when the viewer was opened from outside the app, for example a reload. */
	const fallback = $derived(
		container?.isDevcontainer
			? {
					href: resolve('/mobile/containers/[id]', { id: container.id }),
					label: container.projectName
				}
			: container
				? {
						href: resolve('/mobile/services/container/[id]', { id: container.id }),
						label: container.composeService ?? container.projectName
					}
				: { href: resolve('/mobile/containers'), label: 'Containers' }
	);

	/** Back to the screen that opened the service, or to its container. */
	function back() {
		if (cameFromApp) history.back();
		else if (container?.isDevcontainer)
			void goto(resolve('/mobile/containers/[id]', { id: container.id }));
		else if (container) void goto(resolve('/mobile/services/container/[id]', { id: container.id }));
		else void goto(resolve('/mobile/containers'));
	}

	/** Switch in place: replace this history entry, so Back still leaves the viewer. */
	function switchTo(port: string, label: string, hostPort: string) {
		if (!container || port === containerPort) {
			sheet = null;
			return;
		}
		const href = mobileServiceHref(
			{
				containerPort: port,
				hostPort,
				label,
				containerName: container.name,
				projectName: container.projectName,
				workspacePath: container.localWorkspacePath,
				allPorts: container.ports,
				containerId: container.id,
				serviceProxyEnabled: dashboard.serviceProxyEnabled
			},
			page.url.hostname
		);
		void goto(resolve(href), { replaceState: true, noScroll: true });
	}

	function reload() {
		sheet = null;
		if (embeddable) loaded = reloadLoaded(loaded, currentId);
	}

	/** The address that another browser opens: the direct URL, else the embedded one. */
	const address = $derived(
		viewer.directUrl ?? (viewer.target ? new URL(viewer.target, page.url).href : '')
	);

	async function copyAddress() {
		sheet = null;
		try {
			await navigator.clipboard.writeText(address);
			dashboard.toast('Copied the service address');
		} catch {
			dashboard.toast(`Copy failed: ${address}`);
		}
	}
</script>

<svelte:head>
	<title>{data.label} · {project || 'DevHarbour'}</title>
</svelte:head>

<div
	class="fixed inset-x-0 flex flex-col bg-m-screen"
	style:top="var(--visual-viewport-top, 0px)"
	style:height="var(--visual-viewport-height, 100dvh)"
	data-testid="service-viewer"
>
	<header
		class="shrink-0 border-b border-m-edge bg-m-screen"
		style:padding-top="env(safe-area-inset-top)"
		data-testid="service-header"
	>
		<div class="relative flex h-[52px] items-center gap-1 px-1">
			<button
				type="button"
				onclick={back}
				aria-label="Back"
				class="grid size-11 shrink-0 place-items-center text-m-frost"
				data-testid="service-back"
			>
				<ChevronLeft size={28} strokeWidth={2.2} aria-hidden="true" />
			</button>
			<button
				type="button"
				onclick={() => (sheet = 'services')}
				aria-label={`${data.label}. Switch service`}
				class="flex min-h-11 min-w-0 flex-1 flex-col justify-center text-left"
				data-testid="service-title"
			>
				<span class="flex min-w-0 items-center gap-1.5 text-[16px] leading-tight font-semibold">
					{#if container}<MDot state={container.state} />{/if}
					<span class="truncate">{data.label}</span>
					<ChevronDown size={15} class="shrink-0 text-m-dim" aria-hidden="true" />
				</span>
				{#if context}<span class="truncate text-[14px] leading-tight text-m-dim">{context}</span
					>{/if}
			</button>
			<button
				type="button"
				onclick={() => (sheet = 'more')}
				aria-label="Service actions"
				class="grid size-11 shrink-0 place-items-center text-m-frost"
				data-testid="service-more"
			>
				<MoreHorizontal size={22} aria-hidden="true" />
			</button>
			{#if loading}
				<span
					class="absolute inset-x-0 -bottom-px h-[2px] animate-pulse bg-m-frost"
					role="progressbar"
					aria-label={`Loading ${data.label}`}
				></span>
			{/if}
		</div>
	</header>

	<div class="relative min-h-0 flex-1 overflow-hidden" data-testid="service-area">
		{#each loaded as entry (frameKey(entry))}
			{@const shown = embeddable && entry.id === currentId}
			<iframe
				src={entry.src}
				title={entry.title}
				class="absolute inset-0 size-full border-0 bg-white {shown
					? ''
					: 'pointer-events-none invisible'}"
				inert={!shown}
				aria-hidden={!shown}
				onload={() => (ready = { ...ready, [frameKey(entry)]: true })}
				data-testid={shown ? 'service-frame' : 'service-frame-kept'}
			></iframe>
		{/each}
		{#if !embeddable}
			<div
				class="absolute inset-0 flex flex-col items-center justify-center overflow-y-auto bg-m-screen px-8 text-center"
				data-testid="service-fallback"
			>
				{#if viewer.kind === 'unsupported'}
					<ExternalLink size={34} class="text-m-frost" aria-hidden="true" />
					<h1 class="mt-4 text-[20px] font-bold [overflow-wrap:anywhere]">
						{data.label} opens in Safari
					</h1>
					<p class="mt-2 text-[15px] leading-relaxed text-m-dim">
						This service needs its own address, so it cannot run inside DevHarbour.
					</p>
				{:else}
					<Server size={34} class="text-m-dim" aria-hidden="true" />
					<h1 class="mt-4 text-[20px] font-bold [overflow-wrap:anywhere]">
						{data.label} is not available
					</h1>
					<p class="mt-2 text-[15px] leading-relaxed text-m-dim">
						{viewer.kind === 'proxy-disabled'
							? 'The service gateway is off on this DevHarbour (SERVICE_PROXY_ENABLED).'
							: unavailableText(viewer)}
					</p>
				{/if}
				<div class="mt-6 grid w-full max-w-[340px] gap-2">
					{#if viewer.directUrl}
						<a
							href={viewer.directUrl}
							target="_blank"
							rel="external noreferrer"
							class="flex min-h-[50px] items-center justify-center gap-2 rounded-[14px] bg-m-frost px-3 text-[17px] font-semibold text-m-on-frost"
							data-testid="service-safari"
						>
							<ExternalLink size={18} aria-hidden="true" />Open in Safari
						</a>
					{/if}
					{#if services.length > 1}
						<button
							type="button"
							onclick={() => (sheet = 'services')}
							class="min-h-[50px] rounded-[14px] bg-m-raised px-3 text-[17px] font-semibold"
							>Choose another service</button
						>
					{/if}
				</div>
			</div>
		{:else if loading}
			<div class="pointer-events-none absolute inset-0 grid place-items-center bg-m-screen/70">
				<span class="flex items-center gap-2 text-[15px] text-m-dim"
					><Loader2 size={18} class="animate-spin" aria-hidden="true" />Opening {data.label}…</span
				>
			</div>
		{/if}
	</div>
	{#if !visualViewportState.keyboardOpen}
		<!-- An embedded page cannot read the safe area, so the viewer keeps the home-indicator strip. -->
		<div
			class="shrink-0 bg-m-screen"
			style:height="env(safe-area-inset-bottom)"
			aria-hidden="true"
		></div>
	{/if}
</div>

<MSheet
	open={sheet === 'services'}
	title={project || 'Services'}
	onClose={() => (sheet = null)}
	testid="service-switch-sheet"
>
	{#if workspacePath}
		<p class="px-5 pb-3 font-mono text-[14px] [overflow-wrap:anywhere] text-m-dim">
			{workspace?.name ?? workspacePath}
		</p>
	{/if}
	{#if services.length}
		<MGroup
			footer={`Services you opened stay loaded while you switch, up to ${MAX_LOADED_SERVICES}.`}
		>
			{#each services as entry (entry.containerPort)}
				{@const isCurrent = entry.containerPort === containerPort}
				{@const kept = loaded.some((item) => item.id === `${containerId}:${entry.containerPort}`)}
				<MRow
					title={entry.label}
					subtitle={`Port ${entry.containerPort}${isCurrent ? ' · open' : kept ? ' · loaded' : ''}`}
					tone={isCurrent ? 'bg-m-frost/20 text-m-frost' : undefined}
					onclick={() => switchTo(entry.containerPort, entry.label, entry.hostPort)}
					testid="service-option"
				>
					{#snippet icon()}<Globe size={18} />{/snippet}
					{#snippet trailing()}{#if isCurrent}<Check
								size={19}
								class="shrink-0 text-m-frost"
								aria-label="Shown"
							/>{/if}{/snippet}
				</MRow>
			{/each}
		</MGroup>
	{:else}
		<p class="px-5 pb-4 text-[15px] text-m-dim">
			No other web services are known for this container.
		</p>
	{/if}
</MSheet>

<MSheet
	open={sheet === 'more'}
	title={data.label}
	onClose={() => (sheet = null)}
	testid="service-more-sheet"
>
	<MGroup>
		<MRow title="Reload" onclick={reload} disabled={!embeddable} testid="service-reload">
			{#snippet icon()}<RotateCw size={18} />{/snippet}
		</MRow>
		{#if viewer.directUrl}
			<a
				href={viewer.directUrl}
				target="_blank"
				rel="external noreferrer"
				onclick={() => (sheet = null)}
				class="flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5 text-left active:bg-m-raised/60"
			>
				<span
					class="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-m-raised text-m-frost"
					><ExternalLink size={18} aria-hidden="true" /></span
				>
				<span class="min-w-0 flex-1"
					><span class="block text-[17px] leading-snug">Open in Safari</span><span
						class="mt-0.5 block text-[14px] leading-snug text-m-dim">Leaves DevHarbour</span
					></span
				>
			</a>
		{/if}
		{#if address}
			<MRow title="Copy address" onclick={() => void copyAddress()}>
				{#snippet icon()}<Copy size={18} />{/snippet}
			</MRow>
		{/if}
	</MGroup>
	<MGroup>
		<MRow
			title="Container screen"
			subtitle={fallback.label}
			href={fallback.href}
			testid="service-container"
		>
			{#snippet icon()}<FolderGit2 size={18} />{/snippet}
		</MRow>
	</MGroup>
</MSheet>
