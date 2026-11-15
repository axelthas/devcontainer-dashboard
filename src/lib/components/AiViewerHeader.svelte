<script lang="ts">
	import { FolderOpen, LayoutDashboard } from 'lucide-svelte';
	import { resolve } from '$app/paths';

	let { path, label, dark }: { path: string; label: string; dark: boolean } = $props();
	const project = $derived(path.split('/').filter(Boolean).pop() ?? path);
</script>

<header class={['bar', { dark }]} aria-label="AI service window">
	<div class="bar-left">
		<FolderOpen size={12} class="path-icon" />
		<span class="path" title={path}>{path}</span>
	</div>
	<div class="bar-center">
		<span class="dot" aria-hidden="true"></span>
		<span class="project">{project}</span>
		<span class="sep">·</span>
		<span class="service-name">{label}</span>
	</div>
	<nav class="bar-right" aria-label="Viewer actions">
		<a class="btn" href={resolve('/ai')}>AI status</a>
		<a class="btn" href={resolve('/')}><LayoutDashboard size={14} />Dashboard</a>
	</nav>
</header>

<style>
	/* Match the service viewer's 44px Nord header without relying on utility CSS. */
	.bar {
		--bar-bg: #e5e9f0;
		--bar-border: #d8dee9;
		--text-primary: #2e3440;
		--text-mono: #5e81ac;
		--text-muted: #4c566a;
		--btn-border: #c8d0dc;
		--btn-color: #4c566a;
		--btn-hover-bg: #d8dee9;
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		height: 44px;
		min-height: 44px;
		padding: 0 1rem;
		gap: 1rem;
		flex-shrink: 0;
		background: var(--bar-bg);
		border-bottom: 1px solid var(--bar-border);
		font-family: system-ui, sans-serif;
		overflow: hidden;
	}

	.bar.dark {
		--bar-bg: #3b4252;
		--bar-border: #434c5e;
		--text-primary: #eceff4;
		--text-mono: #81a1c1;
		--text-muted: #7b88a1;
		--btn-border: #4c566a;
		--btn-color: #d8dee9;
		--btn-hover-bg: #434c5e;
	}

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

	.service-name {
		font-size: 0.75rem;
		font-family: ui-monospace, monospace;
		color: var(--text-mono);
	}

	.sep {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.bar-right {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		justify-content: flex-end;
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
		white-space: nowrap;
	}

	.btn:hover {
		background: var(--btn-hover-bg);
	}

	@media (max-width: 640px) {
		.bar {
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 0.5rem;
			padding: 0 0.5rem;
		}

		.bar-center {
			display: none;
		}
	}
</style>
