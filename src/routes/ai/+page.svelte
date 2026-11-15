<script lang="ts">
	import { resolve } from '$app/paths';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { onMount } from 'svelte';
	import TerminalTab from '$lib/components/TerminalTab.svelte';
	import LocalAiButtons from '$lib/components/LocalAiButtons.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let terminalId = $state('');
	let target = $state('');
	let busy = $state(false);
	let message = $state('');
	let dark = $state(true);
	const label = $derived(data.viewer?.tool === 'opencode' ? 'OpenCode TUI' : 'OpenChamber');

	// Only the folder browser polls. A viewer never starts work because data was invalidated.
	$effect(() => {
		if (!data.viewer && data.ai.state === 'starting') {
			const timer = setInterval(() => void invalidateAll(), 3000);
			return () => clearInterval(timer);
		}
	});

	onMount(() => {
		const key = 'devcontainer-dashboard-theme';
		dark = localStorage.getItem(key) !== 'light';
		const syncTheme = (event: StorageEvent) => {
			if (event.key === key) dark = event.newValue !== 'light';
		};
		window.addEventListener('storage', syncTheme);
		const controller = new AbortController();
		if (data.viewer) {
			// Preserve the original runtime across reloads. An old tab cannot launch work after restart.
			const url = new URL(window.location.href);
			url.searchParams.set('instance', data.viewer.instance);
			replaceState(url, {});
			void openViewer(controller.signal);
		}
		return () => {
			controller.abort();
			window.removeEventListener('storage', syncTheme);
		};
	});

	/** POST once per viewer identity; retries and reloads return the same server-owned launch. */
	async function openViewer(signal?: AbortSignal) {
		if (!data.viewer || busy) return;
		busy = true;
		message = '';
		try {
			const response = await fetch('/api/ai/open', {
				method: 'POST',
				signal,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: data.folders.path, ...data.viewer })
			});
			if (!response.ok)
				throw new Error(
					response.status === 401
						? 'Sign in to the dashboard, then open a new service window.'
						: 'Cannot open this service. Check Local AI status and container logs. After a restart, open a new window from the dashboard.'
				);
			const result: { target?: string; terminalId?: string } = await response.json();
			if (signal?.aborted) return;
			if (data.viewer.tool === 'opencode' && result.terminalId) terminalId = result.terminalId;
			else if (data.viewer.tool === 'openchamber' && result.target) target = result.target;
			else throw new Error('The service returned an invalid launch result.');
		} catch (error) {
			if (!signal?.aborted)
				message = error instanceof Error ? error.message : 'Cannot open service.';
		} finally {
			if (!signal?.aborted) busy = false;
		}
	}
</script>

<svelte:head>
	<title
		>{data.viewer ? `${label} | ${data.folders.path}` : 'Local AI | Devcontainer Dashboard'}</title
	>
</svelte:head>

<div class:dark>
	{#if data.viewer}
		<main
			class="flex h-dvh flex-col overflow-hidden bg-[#eceff4] text-[#2e3440] dark:bg-[#2e3440] dark:text-[#eceff4]"
		>
			<header
				class="flex shrink-0 flex-wrap items-center gap-3 border-b border-[#d8dee9] bg-[#e5e9f0] px-4 py-2 text-sm dark:border-[#434c5e] dark:bg-[#3b4252]"
			>
				<span class="min-w-0 flex-1 truncate font-mono" title={data.folders.path}
					>{data.folders.path}</span
				>
				<strong>{label}</strong>
				<span class="text-[#4c566a] dark:text-[#d8dee9]">Dashboard backend</span>
				<a class="rounded border border-[#81a1c1]/50 px-3 py-1" href={resolve('/')}>Dashboard</a>
				{#if target}
					<a
						class="rounded border border-[#81a1c1]/50 px-3 py-1"
						href={target}
						target="_blank"
						rel="noreferrer">Open directly</a
					>
				{/if}
			</header>
			{#if terminalId}
				<div class="min-h-0 flex-1 bg-[#2e3440] p-2">
					<TerminalTab sessionId={terminalId} active={true} focusOnActivate={true} />
				</div>
			{:else if target}
				<iframe class="min-h-0 w-full flex-1 border-0" src={target} title="OpenChamber"></iframe>
			{:else}
				<section
					class="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
					aria-live="polite"
				>
					<h1 class="text-xl font-bold">{busy ? `Opening ${label}...` : label}</h1>
					{#if message}
						<p class="max-w-xl text-[#bf616a]" role="alert">{message}</p>
						<button
							type="button"
							class="rounded border border-[#81a1c1] px-4 py-2"
							onclick={() => openViewer()}
							disabled={busy}>Retry connection</button
						>
					{/if}
					<a class="text-[#5e81ac] underline dark:text-[#88c0d0]" href={resolve('/ai')}
						>Local AI status and folders</a
					>
				</section>
			{/if}
		</main>
	{:else}
		<main
			class="min-h-screen bg-[#eceff4] p-6 text-[#2e3440] dark:bg-[#2e3440] dark:text-[#eceff4]"
		>
			<header class="mb-6 flex flex-wrap items-center justify-between gap-4">
				<div>
					<h1 class="text-2xl font-bold">Local AI folders</h1>
					<p class="text-sm">
						Open a service window for any mounted folder. No devcontainer required.
					</p>
				</div>
				<a class="rounded border border-[#81a1c1] px-4 py-2" href={resolve('/')}>Dashboard</a>
			</header>
			<p class="mb-4" aria-live="polite">
				Shared backend: <strong>{data.ai.enabled ? data.ai.state : 'not enabled'}</strong>
				<button class="ml-3 underline" type="button" onclick={() => invalidateAll()}>Refresh</button
				>
			</p>
			{#if !data.ai.enabled || data.ai.state === 'failed'}
				<p class="mb-4">
					Use the production launcher with the AI volume mounted. Check container logs if startup
					failed. Restart the container to retry.
				</p>
			{/if}
			<section
				class="rounded-xl border border-[#d8dee9] bg-white p-4 dark:border-[#4c566a] dark:bg-[#3b4252]"
				aria-label="Folder picker"
			>
				<div class="mb-4 flex flex-wrap items-center gap-3">
					<span class="min-w-0 flex-1 font-mono text-sm break-all">{data.folders.path}</span>
					<LocalAiButtons path={data.folders.path} disabled={data.ai.state !== 'ready'} />
				</div>
				<nav aria-label="Workspace directories" class="flex flex-col gap-2">
					{#if data.folders.parent}
						<a
							class="text-[#5e81ac] underline dark:text-[#88c0d0]"
							href={resolve(`/ai?path=${encodeURIComponent(data.folders.parent)}`)}>Parent folder</a
						>
					{/if}
					{#each data.folders.children as folder, index (`${folder.name}:${index}`)}
						<div
							class="flex flex-wrap items-center gap-3 rounded px-2 py-2 hover:bg-[#e5e9f0] dark:hover:bg-[#434c5e]"
						>
							<a
								class="min-w-0 flex-1 break-all"
								href={resolve(`/ai?path=${encodeURIComponent(folder.path)}`)}>{folder.name}/</a
							>
							<LocalAiButtons path={folder.path} disabled={data.ai.state !== 'ready'} />
						</div>
					{/each}
				</nav>
			</section>
			<p class="mt-4 text-sm">
				Both interfaces use one OpenCode backend. Each launch creates an empty conversation in the
				selected directory. Existing conversations remain available inside either application.
			</p>
		</main>
	{/if}
</div>
