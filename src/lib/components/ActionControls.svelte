<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Play, Square, RotateCw, Loader2, Trash2, Code, TerminalSquare, Hammer } from 'lucide-svelte';
	import type { ContainerData } from '$lib/types';

	interface Props {
		id: string;
		containerState: string;
		onRefresh: () => Promise<void>;
		vscodeUri?: string;
		onOpenTerminal?: () => void;
		rebuildContainer?: ContainerData;
		onOpenBuild?: (id: string, command: string, name: string, cwd: string) => void;
	}

	let {
		id,
		containerState,
		onRefresh,
		vscodeUri,
		onOpenTerminal,
		rebuildContainer,
		onOpenBuild
	}: Props = $props();

	let loadingAction = $state<string | null>(null);
	let actionError = $state('');
	let rebuildSessionId: string | null = null;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	const canRebuild = $derived(
		Boolean(rebuildContainer?.localWorkspacePath && rebuildContainer?.devcontainerConfigFile)
	);

	onDestroy(() => {
		disposed = true;
		clearTimeout(pollTimer);
	});

	/** Render bounded server messages as text, never HTML, including authentication failures. */
	async function responseError(response: Response): Promise<string> {
		const body = await response.json().catch(() => null);
		return typeof body?.message === 'string'
			? body.message.slice(0, 500)
			: `Request failed (${response.status})`;
	}

	/** Poll operation identity after the old container has been removed; never create a second job. */
	async function pollRebuild() {
		if (disposed || !rebuildSessionId) return;
		try {
			const response = await fetch(
				`/api/containers/${id}/rebuild?sessionId=${encodeURIComponent(rebuildSessionId)}`,
				{ cache: 'no-store' }
			);
			if (disposed) return;
			if (!response.ok) {
				const message = await responseError(response);
				if (response.status === 404) {
					rebuildSessionId = null;
					loadingAction = null;
					actionError = message;
					await onRefresh();
					return;
				}
				throw new Error(message);
			}
			const build = await response.json();
			if (disposed) return;
			if (build.status !== 'running') {
				rebuildSessionId = null;
				loadingAction = null;
				actionError = build.status === 'failed' ? 'Rebuild failed. Check the build terminal or workspace log.' : '';
				await onRefresh();
				return;
			}
			actionError = '';
		} catch (cause) {
			if (!disposed) {
				actionError = `Build status unavailable. The build may still be running. ${cause instanceof Error ? cause.message : 'Check the build terminal.'}`;
			}
		}
		if (!disposed && rebuildSessionId) pollTimer = setTimeout(pollRebuild, 2000);
	}

	/** Confirm replacement separately from restart; the server resolves all filesystem authority. */
	async function handleRebuild() {
		if (!canRebuild || loadingAction !== null || !rebuildContainer) return;
		if (
			!confirm(
				`Rebuild and restart "${rebuildContainer.projectName}" (${id})?\n\nThis replaces the container, interrupts its services and terminals, and discards changes in its writable layer. Workspace files and volumes are not deleted, but lifecycle scripts can change mounted data. There is no automatic rollback.`
			)
		) return;
		loadingAction = 'rebuild';
		actionError = '';
		try {
			const response = await fetch(`/api/containers/${id}/rebuild`, { method: 'POST' });
			if (!response.ok) throw new Error(await responseError(response));
			const build = await response.json();
			if (disposed) return;
			rebuildSessionId = build.id;
			onOpenBuild?.(build.id, '', `Rebuild ${build.repoName}`, build.repoPath);
			void pollRebuild();
		} catch (cause) {
			if (disposed) return;
			if (!rebuildSessionId) loadingAction = null;
			actionError = cause instanceof Error ? cause.message : 'Could not start rebuild';
			// A viewer failure must not hide or cancel an already accepted build.
			if (rebuildSessionId) void pollRebuild();
		}
	}

	async function handleAction(action: 'start' | 'stop' | 'restart' | 'delete') {
		if (action === 'delete' && !confirm('Delete this container? This cannot be undone.')) {
			return;
		}
		loadingAction = action;
		actionError = '';
		try {
			const response = await fetch(`/api/containers/${id}/${action}`, { method: 'POST' });
			if (!response.ok) throw new Error(await responseError(response));
			await onRefresh();
		} catch (cause) {
			actionError = cause instanceof Error ? cause.message : 'Container action failed';
		} finally {
			loadingAction = null;
		}
	}

	const isRunning = $derived(containerState === 'running');
</script>

<div class="flex flex-col items-end gap-1">
	<div
		class="flex items-center gap-1.5 rounded-xl border border-[#d8dee9] bg-[#eceff4] p-1 shadow-sm dark:border-[#434c5e] dark:bg-[#2e3440]"
	>
		{#if vscodeUri}
			<a
				href={vscodeUri}
				rel="external"
				title="Open in VS Code"
				class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#5e81ac] dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#81a1c1]"
			>
				<Code size={16} />
			</a>
		{/if}
		{#if onOpenTerminal}
			<button
				onclick={onOpenTerminal}
				title="Open terminal"
				class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#88c0d0] dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#88c0d0]"
			>
				<TerminalSquare size={16} />
			</button>
		{/if}
		{#if rebuildContainer}
			<button
				class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#d08770] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#d08770]"
				disabled={!canRebuild || loadingAction !== null}
				onclick={handleRebuild}
				aria-label="Rebuild and restart"
				title={canRebuild ? 'Rebuild and restart' : 'Rebuild unavailable: workspace or exact configuration label is missing'}
			>
				{#if loadingAction === 'rebuild'}
					<Loader2 size={16} class="animate-spin" />
				{:else}
					<Hammer size={16} />
				{/if}
			</button>
		{/if}
		{#if isRunning}
			<button
				class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#ebcb8b] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#ebcb8b]"
				disabled={loadingAction !== null}
				onclick={() => handleAction('restart')}
				title="Restart"
			>
				{#if loadingAction === 'restart'}
					<Loader2 size={16} class="animate-spin" />
				{:else}
					<RotateCw size={16} />
				{/if}
			</button>
			<button
				class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#bf616a] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#bf616a]"
				disabled={loadingAction !== null}
				onclick={() => handleAction('stop')}
				title="Stop"
			>
				{#if loadingAction === 'stop'}
					<Loader2 size={16} class="animate-spin" />
				{:else}
					<Square size={16} class="fill-current" />
				{/if}
			</button>
		{:else}
			<button
				class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#a3be8c] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#a3be8c]"
				disabled={loadingAction !== null}
				onclick={() => handleAction('start')}
				title="Start"
			>
				{#if loadingAction === 'start'}
					<Loader2 size={16} class="animate-spin" />
				{:else}
					<Play size={16} class="fill-current" />
				{/if}
			</button>
		{/if}
		<button
			class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#bf616a] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#bf616a]"
			disabled={loadingAction !== null}
			onclick={() => handleAction('delete')}
			title="Delete container"
		>
			{#if loadingAction === 'delete'}
				<Loader2 size={16} class="animate-spin" />
			{:else}
				<Trash2 size={16} />
			{/if}
		</button>
	</div>
	{#if loadingAction === 'rebuild'}
		<p role="status" class="max-w-64 text-xs text-[#4c566a] dark:text-[#d8dee9]">Rebuilding. Output is available in the build terminal.</p>
	{/if}
	{#if actionError}
		<p role="alert" class="max-w-64 text-xs text-[#bf616a]">{actionError}</p>
	{/if}
</div>
