<script lang="ts">
	import { resolve } from '$app/paths';
	import { invalidateAll } from '$app/navigation';
	import { generateId } from '$lib/index';
	import TerminalTab from '$lib/components/TerminalTab.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let terminal = $state<{ id: string; path: string } | null>(null);
	let target = $state('');
	let busy = $state(false);
	let message = $state('');
	let refreshTimer: ReturnType<typeof setInterval> | undefined;

	$effect(() => {
		if (data.ai.state === 'starting') refreshTimer = setInterval(() => void invalidateAll(), 3000);
		return () => clearInterval(refreshTimer);
	});

	async function openChamber() {
		const selectedPath = data.folders.path;
		busy = true;
		message = '';
		try {
			const response = await fetch('/api/ai/open', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: selectedPath })
			});
			if (!response.ok) throw new Error('Cannot open OpenChamber. Check service status and container logs.');
			const result: { target: string } = await response.json();
			if (data.folders.path !== selectedPath) return;
			target = result.target;
			terminal = null;
		} catch (error) {
			message = error instanceof Error ? error.message : 'Cannot open OpenChamber.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Local AI | Devcontainer Dashboard</title></svelte:head>

<main class="min-h-screen bg-[#2e3440] p-6 text-[#eceff4]">
	<header class="mb-6 flex flex-wrap items-center justify-between gap-4">
		<div>
			<h1 class="text-2xl font-bold">Local AI</h1>
			<p class="text-sm text-[#d8dee9]">Open any mounted workspace folder. No devcontainer required.</p>
		</div>
		<a class="rounded border border-[#81a1c1] px-4 py-2" href={resolve('/')}>Dashboard</a>
	</header>
	<p class="mb-4" aria-live="polite">
		Services: <strong>{data.ai.enabled ? data.ai.state : 'not enabled'}</strong>
		<button class="ml-3 underline" type="button" onclick={() => invalidateAll()}>Refresh</button>
	</p>
	{#if !data.ai.enabled || data.ai.state === 'failed'}
		<p class="mb-4 text-[#ebcb8b]">Use the production launcher with the AI volume mounted. Check container logs if startup failed. Restart the container to retry.</p>
	{/if}
	<section class="rounded-xl border border-[#4c566a] bg-[#3b4252] p-4" aria-label="Folder picker">
		<p class="mb-4 break-all font-mono text-sm">{data.folders.path}</p>
		<div class="mb-4 flex flex-wrap gap-3">
			<button type="button" class="rounded bg-[#88c0d0] px-4 py-2 text-[#2e3440] disabled:opacity-40"
				disabled={data.ai.state !== 'ready'}
				onclick={() => { terminal = { id: generateId(), path: data.folders.path }; target = ''; }}>
				Open in OpenCode
			</button>
			<button type="button" class="rounded bg-[#a3be8c] px-4 py-2 text-[#2e3440] disabled:opacity-40"
				disabled={busy || data.ai.state !== 'ready'} onclick={openChamber}>
				{busy ? 'Opening...' : 'New OpenChamber session'}
			</button>
		</div>
		<p class="mb-4 text-sm text-[#d8dee9]">OpenCode runs in the dashboard terminal. OpenChamber opens a new session in this folder. Existing conversations remain available in either application.</p>
		<nav aria-label="Workspace directories" class="flex max-h-64 flex-col gap-2 overflow-auto">
			{#if data.folders.parent}
				<a class="text-[#88c0d0] underline" href={resolve(`/ai?path=${encodeURIComponent(data.folders.parent)}`)}>Parent folder</a>
			{/if}
			{#each data.folders.children as folder, index (`${folder.name}:${index}`)}
				<a class="rounded px-2 py-1 hover:bg-[#434c5e]" href={resolve(`/ai?path=${encodeURIComponent(folder.path)}`)}>{folder.name}/</a>
			{/each}
		</nav>
	</section>
	{#if message}<p class="my-4 text-[#bf616a]" role="alert">{message}</p>{/if}
	{#if terminal}
		<section class="mt-4" aria-label="OpenCode terminal">
			<p class="mb-2 break-all text-sm">{terminal.path}</p>
			<div class="h-[65vh] overflow-hidden rounded-xl border border-[#4c566a]">
				{#key terminal.id}
					<TerminalTab sessionId={terminal.id} command="opencode" cwd={terminal.path} active={true} />
				{/key}
			</div>
		</section>
	{/if}
	{#if target}
		<section class="mt-4" aria-label="OpenChamber viewer">
			<a class="mb-2 inline-block text-[#88c0d0] underline" href={target} target="_blank" rel="noreferrer">Open directly (if embedding is blocked)</a>
			<iframe class="h-[75vh] w-full rounded-xl border border-[#4c566a]" src={target} title="OpenChamber"></iframe>
		</section>
	{/if}
</main>
