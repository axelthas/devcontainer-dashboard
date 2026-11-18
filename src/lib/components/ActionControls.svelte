<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		Play,
		Square,
		RotateCw,
		Loader2,
		Trash2,
		Code,
		TerminalSquare,
		Hammer
	} from 'lucide-svelte';
	import type { ContainerData } from '$lib/types';
	import { ContainerActions } from '$lib/containerActions.svelte';

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

	// Lifecycle requests and rebuild polling are shared with the devcontainer menus.
	const actions = new ContainerActions(() => ({ id, onRefresh, rebuildContainer, onOpenBuild }));
	onDestroy(() => actions.dispose());

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
				disabled={!actions.canRebuild || actions.busy}
				onclick={() => actions.rebuild()}
				aria-label="Rebuild and restart"
				title={actions.canRebuild
					? 'Rebuild and restart'
					: 'Rebuild unavailable: workspace or exact configuration label is missing'}
			>
				{#if actions.loadingAction === 'rebuild'}
					<Loader2 size={16} class="animate-spin" />
				{:else}
					<Hammer size={16} />
				{/if}
			</button>
		{/if}
		{#if isRunning}
			<button
				class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#ebcb8b] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#ebcb8b]"
				disabled={actions.busy}
				onclick={() => actions.run('restart')}
				title="Restart"
			>
				{#if actions.loadingAction === 'restart'}
					<Loader2 size={16} class="animate-spin" />
				{:else}
					<RotateCw size={16} />
				{/if}
			</button>
			<button
				class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#bf616a] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#bf616a]"
				disabled={actions.busy}
				onclick={() => actions.run('stop')}
				title="Stop"
			>
				{#if actions.loadingAction === 'stop'}
					<Loader2 size={16} class="animate-spin" />
				{:else}
					<Square size={16} class="fill-current" />
				{/if}
			</button>
		{:else}
			<button
				class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#a3be8c] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#a3be8c]"
				disabled={actions.busy}
				onclick={() => actions.run('start')}
				title="Start"
			>
				{#if actions.loadingAction === 'start'}
					<Loader2 size={16} class="animate-spin" />
				{:else}
					<Play size={16} class="fill-current" />
				{/if}
			</button>
		{/if}
		<button
			class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#bf616a] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#bf616a]"
			disabled={actions.busy}
			onclick={() => actions.run('delete')}
			title="Delete container"
		>
			{#if actions.loadingAction === 'delete'}
				<Loader2 size={16} class="animate-spin" />
			{:else}
				<Trash2 size={16} />
			{/if}
		</button>
	</div>
	{#if actions.loadingAction === 'rebuild'}
		<p role="status" class="max-w-64 text-xs text-[#4c566a] dark:text-[#d8dee9]">
			Rebuilding. Output is available in the build terminal.
		</p>
	{/if}
	{#if actions.actionError}
		<p role="alert" class="max-w-64 text-xs text-[#bf616a]">{actions.actionError}</p>
	{/if}
</div>
