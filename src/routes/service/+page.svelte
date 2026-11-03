<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { ExternalLink, LayoutDashboard, FolderOpen, Server } from 'lucide-svelte';
	import { PORT_MAP } from '$lib/portConfig';
	import { serviceViewerHref } from '$lib/serviceTargets';
	import type { PageData } from './$types';

	/** Viewer contract returned by the server load; see src/routes/service/+page.server.ts. */
	interface ViewerContract {
		kind: 'proxy' | 'legacy' | 'unsupported' | 'unavailable' | 'proxy-disabled';
		target?: string;
		directUrl?: string;
		containerId?: string;
		containerPort?: string;
		reason?: string;
	}

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();

	const viewer: ViewerContract = $derived(data.viewer);
	const label = $derived(data.label);
	const project = $derived(data.project);
	const container = $derived(data.container);
	const workspacePath = $derived(data.workspacePath);
	const allPorts = $derived(data.allPorts);

	// Validated service identity driving gateway switching and active-state matching.
	// The viewer carries it once the server populates the contract; fall back to the
	// load's query-derived identity so switching works in either shape.
	const identityContainerId = $derived(viewer.containerId ?? data.containerId);
	const identityContainerPort = $derived(viewer.containerPort ?? data.containerPort);

	const portEntries = $derived(allPorts ? Object.entries(allPorts) : []);

	const UNAVAILABLE_REASONS: Record<string, string> = {
		'unknown-container': 'This container is no longer available.',
		'not-running': 'The container is not running. Start it from the dashboard.',
		'no-published-binding': 'The service has no published port.',
		'port-not-allowed': 'This port is not enabled as a web service.',
		'proxy-disabled': 'The service gateway is disabled on this dashboard (SERVICE_PROXY_ENABLED).',
		'missing-identity': 'No service selected.'
	};

	const unavailableMessage = $derived(
		(viewer.kind === 'unavailable' && viewer.reason && UNAVAILABLE_REASONS[viewer.reason]) ||
			'This service is not available.'
	);

	function switchService(containerPort: string) {
		const config = PORT_MAP[containerPort];
		const newLabel = config?.label ?? `Port ${containerPort}`;

		// Gateway mode: switch by validated container identity.
		if (identityContainerId) {
			goto(
				resolve(
					serviceViewerHref({
						containerId: identityContainerId,
						containerPort,
						label: newLabel,
						...(data.project ? { projectName: data.project } : {}),
						...(data.container ? { containerName: data.container } : {}),
						...(data.workspacePath ? { workspacePath: data.workspacePath } : {}),
						...(data.allPorts && Object.keys(data.allPorts).length > 1
							? { allPorts: data.allPorts }
							: {})
					})
				),
				{ replaceState: true }
			);
			return;
		}

		// Legacy mode: keep reconstructing the raw host-port URL and updating query params.
		const hostPort = allPorts?.[containerPort];
		if (!hostPort) return;
		const newUrl = `http://${page.url.hostname}:${hostPort}`;
		const params = new SvelteURLSearchParams(page.url.searchParams);
		params.set('url', newUrl);
		params.set('label', newLabel);
		goto(resolve(`/service?${params}`), { replaceState: true });
	}

	const THEME_KEY = 'devcontainer-dashboard-theme';

	let dark = $state(true);

	$effect(() => {
		const stored = localStorage.getItem(THEME_KEY);
		dark = stored !== null ? stored === 'dark' : true;

		function onStorage(e: StorageEvent) {
			if (e.key === THEME_KEY && e.newValue !== null) {
				dark = e.newValue === 'dark';
			}
		}

		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	});
</script>

<svelte:head>
	<title>{label} – {project || container}</title>
</svelte:head>

<div class="frame" class:dark>
	<header class="bar">
		<!-- Left: workspace path -->
		<div class="bar-left">
			{#if workspacePath}
				<FolderOpen size={12} class="path-icon" />
				<span class="path" title={workspacePath}>{workspacePath}</span>
			{/if}
		</div>

		<!-- Center: status dot + project + container -->
		<div class="bar-center">
			<span class="dot"></span>
			{#if project}
				<span class="project">{project}</span>
			{/if}
			{#if container}
				<span class="sep">·</span>
				<span class="container-name">{container}</span>
			{/if}
		</div>

		<!-- Right: actions -->
		<div class="bar-right">
			{#if portEntries.length > 1}
				<div class="switcher">
					{#each portEntries as [containerPort, hostPort] (containerPort)}
						{@const config = PORT_MAP[containerPort]}
						{@const portLabel = config?.label ?? `Port ${containerPort}`}
						{@const IconComponent = config?.icon ?? Server}
						{@const isActive =
							viewer.kind === 'legacy'
								? viewer.target === `http://${page.url.hostname}:${hostPort}`
								: identityContainerPort === containerPort}
						<button
							class="btn {isActive ? 'btn-active' : ''}"
							onclick={() => switchService(containerPort)}
						>
							<IconComponent size={14} />
							{portLabel}
						</button>
					{/each}
				</div>
				<span class="divider"></span>
			{/if}
			<a href={resolve('/')} class="btn">
				<LayoutDashboard size={14} />
				Dashboard
			</a>
			{#if viewer.directUrl}
				<a
					href={viewer.directUrl}
					target="_blank"
					rel="external noreferrer"
					class="btn btn-primary"
				>
					<ExternalLink size={14} />
					Open directly
				</a>
			{/if}
		</div>
	</header>

	{#if (viewer.kind === 'proxy' || viewer.kind === 'legacy') && viewer.target}
		<iframe src={viewer.target} title={label}></iframe>
	{:else if viewer.kind === 'unsupported'}
		<div class="panel">
			<p class="message">{label} cannot be embedded under the dashboard origin.</p>
			<p class="hint">
				This application requires its own HTTPS origin. Open it directly in a new tab instead.
			</p>
			{#if viewer.directUrl}
				<a
					href={viewer.directUrl}
					target="_blank"
					rel="external noreferrer"
					class="btn btn-primary"
				>
					<ExternalLink size={14} />
					Open directly
				</a>
			{/if}
		</div>
	{:else if viewer.kind === 'proxy-disabled'}
		<div class="panel">
			<p class="message">
				The service gateway is disabled on this dashboard (SERVICE_PROXY_ENABLED).
			</p>
		</div>
	{:else}
		<div class="panel">
			<p class="message">{unavailableMessage}</p>
			<p class="hint">
				If it was just restarted, close this tab and launch the service from the dashboard again.
			</p>
			{#if viewer.directUrl}
				<a
					href={viewer.directUrl}
					target="_blank"
					rel="external noreferrer"
					class="btn btn-primary"
				>
					<ExternalLink size={14} />
					Open directly
				</a>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* Light mode defaults */
	.frame {
		--bar-bg: #e5e9f0;
		--bar-border: #d8dee9;
		--text-primary: #2e3440;
		--text-mono: #5e81ac;
		--text-muted: #4c566a;
		--btn-border: #c8d0dc;
		--btn-color: #4c566a;
		--btn-hover-bg: #d8dee9;
		--btn-primary-border: #5e81ac;
		--btn-primary-color: #5e81ac;
		--btn-primary-hover-bg: #5e81ac1a;
	}

	/* Dark mode overrides */
	.frame.dark {
		--bar-bg: #3b4252;
		--bar-border: #434c5e;
		--text-primary: #eceff4;
		--text-mono: #81a1c1;
		--text-muted: #7b88a1;
		--btn-border: #4c566a;
		--btn-color: #d8dee9;
		--btn-hover-bg: #434c5e;
		--btn-primary-border: #5e81ac;
		--btn-primary-color: #88c0d0;
		--btn-primary-hover-bg: #5e81ac22;
	}

	.frame {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
	}

	.bar {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		height: 44px;
		padding: 0 1rem;
		gap: 1rem;
		flex-shrink: 0;
		background: var(--bar-bg);
		border-bottom: 1px solid var(--bar-border);
		transition:
			background 0.2s,
			border-color 0.2s;
		overflow: hidden;
	}

	/* Left */
	.bar-left {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
		overflow: hidden;
	}

	.bar-left :global(.path-icon) {
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.path {
		font-size: 0.7rem;
		font-family: ui-monospace, monospace;
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* Center */
	.bar-center {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		white-space: nowrap;
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
		background: #a3be8c;
		box-shadow: 0 0 6px rgba(163, 190, 140, 0.55);
	}

	.project {
		font-size: 0.8rem;
		font-weight: 700;
		color: var(--text-primary);
	}

	.container-name {
		font-size: 0.75rem;
		font-family: ui-monospace, monospace;
		color: var(--text-mono);
	}

	.sep {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	/* Right */
	.bar-right {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		justify-content: flex-end;
		flex-shrink: 0;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.25rem 0.65rem;
		border-radius: 6px;
		font-size: 0.7rem;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid var(--btn-border);
		background: transparent;
		color: var(--btn-color);
		text-decoration: none;
		transition: background 0.15s;
		white-space: nowrap;
	}

	.btn:hover {
		background: var(--btn-hover-bg);
	}

	.btn-active {
		border-color: var(--btn-primary-border);
		color: var(--btn-primary-color);
		background: var(--btn-primary-hover-bg);
	}

	.btn-active:hover {
		background: var(--btn-primary-hover-bg);
		opacity: 0.85;
	}

	.btn-primary {
		border-color: var(--btn-primary-border);
		color: var(--btn-primary-color);
	}

	.btn-primary:hover {
		background: var(--btn-primary-hover-bg);
	}

	.switcher {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.divider {
		display: inline-block;
		width: 1px;
		height: 18px;
		background: var(--bar-border);
		margin: 0 0.25rem;
		flex-shrink: 0;
	}

	iframe {
		flex: 1;
		width: 100%;
		border: none;
		display: block;
	}

	.panel {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		padding: 2rem;
		text-align: center;
	}

	.panel .message {
		font-size: 0.95rem;
		color: var(--text-primary);
	}

	.panel .hint {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
</style>
