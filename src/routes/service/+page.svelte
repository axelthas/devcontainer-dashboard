<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { ExternalLink, LayoutDashboard, FolderOpen, Server } from 'lucide-svelte';
	import { PORT_MAP } from '$lib/portConfig';

	const url = $derived(page.url.searchParams.get('url') ?? '');
	const label = $derived(page.url.searchParams.get('label') ?? 'Service');
	const project = $derived(page.url.searchParams.get('project') ?? '');
	const container = $derived(page.url.searchParams.get('container') ?? '');
	const workspacePath = $derived(page.url.searchParams.get('path') ?? '');
	const hostnameParam = $derived(page.url.searchParams.get('hostname') ?? '');

	const allPorts = $derived.by(() => {
		const raw = page.url.searchParams.get('ports');
		if (!raw) return null;
		try {
			return JSON.parse(raw) as Record<string, string>;
		} catch {
			return null;
		}
	});

	const portEntries = $derived(allPorts ? Object.entries(allPorts) : []);

	function switchService(containerPort: string, hostPort: string) {
		const config = PORT_MAP[containerPort];
		const newLabel = config?.label ?? `Port ${containerPort}`;
		const newUrl = `http://${hostnameParam}:${hostPort}`;
		const params = new URLSearchParams(page.url.searchParams);
		params.set('url', newUrl);
		params.set('label', newLabel);
		goto(`/service?${params}`, { replaceState: true });
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
					{#each portEntries as [containerPort, hostPort]}
						{@const config = PORT_MAP[containerPort]}
						{@const portLabel = config?.label ?? `Port ${containerPort}`}
						{@const IconComponent = config?.icon ?? Server}
						{@const isActive = url === `http://${hostnameParam}:${hostPort}`}
						<button
							class="btn {isActive ? 'btn-active' : ''}"
							onclick={() => switchService(containerPort, hostPort)}
						>
							<IconComponent size={14} />
							{portLabel}
						</button>
					{/each}
				</div>
				<span class="divider"></span>
			{/if}
			<a href="/" class="btn">
				<LayoutDashboard size={14} />
				Dashboard
			</a>
			<button class="btn btn-primary" onclick={() => window.open(url, '_blank')}>
				<ExternalLink size={14} />
				Open directly
			</button>
		</div>
	</header>

	{#if url}
		<iframe src={url} title={label}></iframe>
	{:else}
		<div class="error">No service URL provided.</div>
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
		--error-color: #bf616a;
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
		--error-color: #bf616a;
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
		transition: background 0.2s, border-color 0.2s;
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

	.error {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--error-color);
		font-size: 0.875rem;
	}
</style>
