<script lang="ts">
	import { page } from '$app/state';
	import { ExternalLink, LayoutDashboard, FolderOpen } from 'lucide-svelte';

	const url = $derived(page.url.searchParams.get('url') ?? '');
	const label = $derived(page.url.searchParams.get('label') ?? 'Service');
	const project = $derived(page.url.searchParams.get('project') ?? '');
	const container = $derived(page.url.searchParams.get('container') ?? '');
	const workspacePath = $derived(page.url.searchParams.get('path') ?? '');

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
		<div class="bar-main">
			<div class="identity">
				{#if project}
					<span class="project">{project}</span>
				{/if}
				{#if container}
					<span class="sep">·</span>
					<span class="container-name">{container}</span>
				{/if}
			</div>
			<div class="actions">
				<a href="/" class="btn">
					<LayoutDashboard size={14} />
					Dashboard
				</a>
				<button class="btn btn-primary" onclick={() => window.open(url, '_blank')}>
					<ExternalLink size={14} />
					Open directly
				</button>
			</div>
		</div>
		{#if workspacePath}
			<div class="path-row">
				<FolderOpen size={12} class="path-icon" />
				<span class="path" title={workspacePath}>{workspacePath}</span>
			</div>
		{/if}
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
		--path-bg: #eceff4;
		--path-border: #d8dee9;
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
		--path-bg: #2e3440;
		--path-border: #3b4252;
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
		flex-shrink: 0;
		background: var(--bar-bg);
		border-bottom: 1px solid var(--bar-border);
		transition: background 0.2s, border-color 0.2s;
	}

	.bar-main {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		height: 40px;
		padding: 0 1rem;
		overflow: hidden;
	}

	.identity {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		overflow: hidden;
	}

	.project {
		font-size: 0.8rem;
		font-weight: 700;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex-shrink: 0;
	}

	.container-name {
		font-size: 0.75rem;
		font-family: ui-monospace, monospace;
		color: var(--text-mono);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex-shrink: 1;
		min-width: 0;
	}

	.sep {
		font-size: 0.75rem;
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.path-row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		height: 24px;
		padding: 0 1rem;
		background: var(--path-bg);
		border-top: 1px solid var(--path-border);
		transition: background 0.2s, border-color 0.2s;
	}

	.path-row :global(.path-icon) {
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

	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
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
		transition: background 0.15s, color 0.15s;
	}

	.btn:hover {
		background: var(--btn-hover-bg);
	}

	.btn-primary {
		border-color: var(--btn-primary-border);
		color: var(--btn-primary-color);
	}

	.btn-primary:hover {
		background: var(--btn-primary-hover-bg);
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
