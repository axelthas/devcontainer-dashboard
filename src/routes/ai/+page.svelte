<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import OpenWithMenu from '$lib/components/OpenWithMenu.svelte';
	import AiViewerHeader from '$lib/components/AiViewerHeader.svelte';
	import TerminalTab from '$lib/components/TerminalTab.svelte';
	import TerminalManager from '$lib/components/TerminalManager.svelte';
	import TerminalEngineSelect from '$lib/components/TerminalEngineSelect.svelte';
	import { defaultTerminalEngine } from '$lib/terminalEnginePreference.svelte';
	import {
		DEFAULT_TERMINAL_ENGINE,
		isTerminalEngineId,
		type TerminalEngineId,
		type TerminalViewIdentity
	} from '$lib/terminalView';
	import type { TerminalSession } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let terminalId = $state('');
	let message = $state('');
	let busy = $state(false);
	let dark = $state(true);
	let terminalOpen = $state(false);
	let terminalSessions = $state<TerminalSession[]>([]);
	let activeTerminalId = $state<string | null>(null);
	/** Engine of the OpenCode TUI viewer; switching it reattaches to the same PTY. */
	let engine = $state<TerminalEngineId>(DEFAULT_TERMINAL_ENGINE);
	let identity = $state<TerminalViewIdentity>();

	/** Reuse the dashboard terminal drawer for ordinary folder shells. */
	function openTerminal(id: string, command: string, name: string, cwd: string) {
		terminalSessions = [...terminalSessions, { id, command, name, cwd }];
		activeTerminalId = id;
		terminalOpen = true;
	}

	/** Explicit drawer close stops only the selected shell, not either AI service. */
	async function closeTerminal(id: string) {
		const response = await fetch('/api/terminal/sessions', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id })
		});
		if (!response.ok) throw new Error('Cannot stop terminal.');
		terminalSessions = terminalSessions.filter((session) => session.id !== id);
		if (activeTerminalId === id) activeTerminalId = terminalSessions.at(-1)?.id ?? null;
		if (!terminalSessions.length) terminalOpen = false;
	}

	/** Switch the viewer and keep the choice in the URL, so a reload uses it too. */
	function changeEngine(next: TerminalEngineId) {
		engine = next;
		const query = new URLSearchParams(page.url.searchParams);
		query.set('engine', next);
		replaceState(resolve(`/ai?${query}`), {});
	}

	onMount(() => {
		const requested = page.url.searchParams.get('engine');
		engine = isTerminalEngineId(requested) ? requested : defaultTerminalEngine();
		dark = localStorage.getItem('devcontainer-dashboard-theme') !== 'light';
		const syncTheme = (event: StorageEvent) => {
			if (event.key === 'devcontainer-dashboard-theme') dark = event.newValue !== 'light';
		};
		window.addEventListener('storage', syncTheme);
		const controller = new AbortController();
		if (data.viewer) void openViewer(controller.signal);
		const timer =
			!data.viewer && data.status.state === 'starting'
				? setInterval(() => void invalidateAll(), 2000)
				: undefined;
		return () => {
			controller.abort();
			clearInterval(timer);
			window.removeEventListener('storage', syncTheme);
		};
	});

	/** Open a directory-only window; reloads reattach to the same live PTY, not a new conversation. */
	async function openViewer(signal?: AbortSignal) {
		if (!data.viewer || busy) return;
		busy = true;
		message = '';
		try {
			const response = await fetch('/api/ai/open', {
				method: 'POST',
				signal,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...data.viewer, path: data.folders.path })
			});
			if (!response.ok)
				throw new Error(
					response.status === 401
						? 'Sign in to the dashboard, then reload this window.'
						: 'Cannot open AI. Check AI status and container logs.'
				);
			const result: { path: string; terminalId?: string } = await response.json();
			if (signal?.aborted) return;
			if (data.viewer.tool === 'opencode' && result.terminalId) terminalId = result.terminalId;
			else if (data.viewer.tool === 'openchamber' && result.path) {
				const query = new URLSearchParams({
					local: 'openchamber',
					directory: result.path,
					label: 'OpenChamber',
					project: data.folders.path.split('/').pop() ?? '',
					container: 'Dashboard',
					path: data.folders.path
				});
				// A normal browser navigation avoids router-initialization races.
				window.location.replace(resolve(`/service?${query}`));
			} else throw new Error('Invalid AI launch response.');
		} catch (error) {
			if (!signal?.aborted) message = error instanceof Error ? error.message : 'Cannot open AI.';
		} finally {
			if (!signal?.aborted) busy = false;
		}
	}
</script>

<svelte:head>
	<title
		>{data.viewer?.tool === 'opencode'
			? 'OpenCode TUI'
			: data.viewer
				? 'OpenChamber'
				: 'AI folders'} | {data.folders.path}</title
	>
</svelte:head>

<div class:dark>
	<main
		class="flex min-h-dvh flex-col bg-[#eceff4] text-[#2e3440] dark:bg-[#2e3440] dark:text-[#eceff4]"
		class:h-dvh={Boolean(data.viewer)}
	>
		<AiViewerHeader
			path={data.folders.path}
			label={data.viewer?.tool === 'opencode'
				? 'OpenCode TUI'
				: data.viewer
					? 'OpenChamber'
					: 'AI folders'}
			{dark}
		/>
		{#if terminalId}
			<div class="flex min-h-0 flex-1 flex-col gap-1 bg-[#2e3440] p-2">
				<div class="flex shrink-0 flex-wrap items-center gap-3">
					<TerminalEngineSelect
						label="Engine"
						value={engine}
						help="Switch how OpenCode TUI is displayed. OpenCode keeps running."
						onSelect={changeEngine}
					/>
					{#if identity}
						<span class="truncate text-[11px] text-[#d8dee9]/60"
							>{identity.core} · {identity.renderer}</span
						>
					{/if}
				</div>
				<div class="min-h-0 flex-1">
					<TerminalTab
						sessionId={terminalId}
						{engine}
						active={true}
						focusOnActivate={true}
						onIdentity={(next) => (identity = next)}
						onUseFallback={() => changeEngine('xterm')}
					/>
				</div>
			</div>
		{:else if data.viewer}
			<section
				class="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
				aria-live="polite"
			>
				<p>{busy ? 'Opening AI service...' : 'AI service window'}</p>
				{#if message}
					<p role="alert" class="max-w-xl text-[#bf616a]">{message}</p>
					<button
						type="button"
						disabled={busy}
						onclick={() => openViewer()}
						class="rounded border border-[#81a1c1] px-4 py-2">Retry connection</button
					>
				{/if}
			</section>
		{:else}
			<section class="space-y-4 p-6">
				<p aria-live="polite">
					Shared AI services: <strong>{data.status.state}</strong>
					<button type="button" onclick={() => invalidateAll()} class="ml-3 underline"
						>Refresh</button
					>
				</p>
				{#if data.status.message}<p>{data.status.message}</p>{/if}
				<p class="text-sm">
					One OpenCode server serves both interfaces. Opening a folder does not create a
					conversation. A conversation is created only when you send its first message.
				</p>
				<p class="text-sm">
					OpenChamber has its own login. Set OPENCODE_PASSWORD through --env-file, or read the
					generated password with <code
						>docker exec &lt;container&gt; cat /dashboard-ai/ui-password</code
					>.
				</p>
				<div class="flex flex-wrap items-center gap-3 rounded border border-[#81a1c1]/40 p-3">
					<span class="min-w-0 flex-1 font-mono text-sm break-all">{data.folders.path}</span>
					<OpenWithMenu
						path={data.folders.path}
						vscodeSshHost={data.vscodeSshHost}
						aiDisabled={data.status.state !== 'ready'}
						onOpenTerminal={openTerminal}
					/>
				</div>
				<nav aria-label="Workspace directories" class="space-y-2">
					{#if data.folders.parent}
						<a
							class="block underline"
							href={resolve(`/ai?path=${encodeURIComponent(data.folders.parent)}`)}>Parent folder</a
						>
					{/if}
					{#each data.folders.children as folder (folder.name)}
						<div
							class="flex flex-wrap items-center gap-3 rounded border border-[#d8dee9] p-3 dark:border-[#434c5e]"
						>
							<a
								class="min-w-0 flex-1 break-all"
								href={resolve(`/ai?path=${encodeURIComponent(folder.path)}`)}>{folder.name}/</a
							>
							<OpenWithMenu
								path={folder.path}
								vscodeSshHost={data.vscodeSshHost}
								aiDisabled={data.status.state !== 'ready'}
								onOpenTerminal={openTerminal}
							/>
						</div>
					{/each}
				</nav>
			</section>
		{/if}
	</main>
	{#if !data.viewer && terminalSessions.length}
		<TerminalManager
			open={terminalOpen}
			sessions={terminalSessions}
			activeId={activeTerminalId}
			workspaceRoot={data.folders.path}
			onToggle={() => (terminalOpen = !terminalOpen)}
			onAddSession={(session) => (terminalSessions = [...terminalSessions, session])}
			onCloseSession={closeTerminal}
			onSetActive={(id) => (activeTerminalId = id)}
		/>
	{/if}
</div>
