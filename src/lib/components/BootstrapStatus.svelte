<script lang="ts">
	import { Settings, GitBranch, ChevronDown, RefreshCw, ArrowDownToLine, RotateCcw, Loader, Play } from 'lucide-svelte';
	import { generateId } from '$lib/index';
	import type { BootstrapToolInfo, BootstrapProvider } from '$lib/types';
	import TerminalTab from './TerminalTab.svelte';

	interface Props { onBootstrap?: () => void; }
	let { onBootstrap }: Props = $props();
	let info = $state<BootstrapToolInfo | null>(null);
	let provider = $state<BootstrapProvider | null>(null);
	let loading = $state(true);
	let branchPickerOpen = $state(false);
	let pulling = $state(false);
	let checkingOut = $state(false);
	let pullMessage = $state<string | null>(null);
	let updating = $state(false);
	let updateSessionId = $state<string | null>(null);
	let updateTerminalVisible = $state(false);
	let updateFailed = $state(false);
	let versionHighlight = $state(false);
	let previousVersion = $state<string | null>(null);
	$effect(() => { void fetchBootstrapInfo(); });
	$effect(() => {
		if (info?.version && previousVersion !== null && info.version !== previousVersion) {
			versionHighlight = true;
			const timer = setTimeout(() => (versionHighlight = false), 2000);
			previousVersion = info.version;
			return () => clearTimeout(timer);
		}
		if (info?.version) previousVersion = info.version;
	});
	async function fetchBootstrapInfo() {
		loading = true;
		try {
			const [infoRes, providerRes] = await Promise.all([fetch('/api/bootstrap'), fetch('/api/bootstrap/providers')]);
			if (infoRes.ok) info = await infoRes.json();
			if (providerRes.ok) { const providers = await providerRes.json(); if (providers.length > 0) provider = providers[0]; }
		} finally { loading = false; }
	}
	async function pullBranch() {
		pulling = true;
		pullMessage = null;
		try {
			const response = await fetch('/api/bootstrap/pull', { method: 'POST' });
			const data = await response.json();
			pullMessage = response.ok ? data.output || 'Pull complete' : `Error: ${data.message || 'Pull failed'}`;
			if (response.ok) await fetchBootstrapInfo();
		} catch { pullMessage = 'Error: Network request failed'; }
		finally { pulling = false; }
	}
	async function checkoutBranch(branch: string) {
		if (!info || branch === info.currentBranch) { branchPickerOpen = false; return; }
		checkingOut = true;
		try {
			const response = await fetch('/api/bootstrap/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ branch }) });
			if (response.ok) await fetchBootstrapInfo();
		} finally { checkingOut = false; branchPickerOpen = false; }
	}
	function updateBootstrap() {
		if (!provider || updating) return;
		updating = true;
		updateFailed = false;
		updateSessionId = generateId();
		updateTerminalVisible = true;
	}
	function onUpdateExit(exitCode: number) {
		updating = false;
		if (exitCode === 0) { updateTerminalVisible = false; updateSessionId = null; void fetchBootstrapInfo(); }
		else updateFailed = true;
	}
	function dismissUpdateTerminal() { updateTerminalVisible = false; updateSessionId = null; updateFailed = false; }
</script>

{#if !loading && info?.installed}
	<div class="rounded-xl border border-[#d8dee9] bg-white px-4 py-3 shadow-sm dark:border-[#4c566a] dark:bg-[#3b4252]">
		<div class="flex flex-wrap items-center gap-x-5 gap-y-2">
			<div class="flex items-center gap-1.5"><Settings size={14} class="text-[#b48ead]" /><span class="text-xs font-bold text-[#2e3440] dark:text-[#eceff4]">Bootstrap</span>{#if provider}<span class="text-[10px] text-[#4c566a] dark:text-[#d8dee9]/50">({provider.name})</span>{/if}</div>
			{#if info.version}<div class="font-mono text-xs text-[#2e3440] dark:text-[#eceff4]" class:font-bold={versionHighlight}>v{info.version}</div>{/if}
			{#if info.currentBranch || info.remoteBranches?.length}
				<div class="relative flex items-center gap-1.5">
					<GitBranch size={12} class="text-[#81a1c1]" />
					<button type="button" onclick={() => (branchPickerOpen = !branchPickerOpen)} class="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-[#5e81ac] dark:text-[#88c0d0]">{#if checkingOut}<Loader size={10} class="animate-spin" />{/if}{info.currentBranch}<ChevronDown size={10} /></button>
					{#if branchPickerOpen}<div class="absolute top-full left-0 z-20 mt-1 max-h-64 w-64 overflow-y-auto rounded-lg border border-[#4c566a] bg-white shadow-lg dark:bg-[#3b4252]">
						{#each [...new Set([...(info.availableBranches ?? []), ...(info.remoteBranches ?? [])])] as branch (branch)}<button type="button" onclick={() => checkoutBranch(branch)} class="w-full px-3 py-1.5 text-left text-xs text-[#5e81ac] dark:text-[#88c0d0]">{branch}{branch === info.currentBranch ? ' ✓' : ''}</button>{/each}
					</div>{/if}
				</div>
			{/if}
			<div class="ml-auto flex items-center gap-2">
				{#if onBootstrap}<button type="button" onclick={onBootstrap} class="flex items-center gap-1.5 rounded-lg bg-[#88c0d0] px-3 py-1.5 text-xs text-[#2e3440]"><Play size={12} />Run Bootstrap</button>{/if}
				<button type="button" onclick={pullBranch} disabled={pulling} class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[#5e81ac] dark:text-[#88c0d0]">{#if pulling}<Loader size={12} class="animate-spin" />{:else}<ArrowDownToLine size={12} />{/if}Pull</button>
				<button type="button" onclick={updateBootstrap} disabled={updating} class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[#b48ead]">{#if updating}<Loader size={12} class="animate-spin" />{:else}<RotateCcw size={12} />{/if}Update</button>
				<button type="button" onclick={fetchBootstrapInfo} aria-label="Refresh bootstrap info" class="p-1.5 text-[#5e81ac] dark:text-[#88c0d0]"><RefreshCw size={13} /></button>
			</div>
		</div>
		{#if pullMessage}<div role="status" class="mt-2 whitespace-pre-wrap font-mono text-xs text-[#4c566a] dark:text-[#d8dee9]">{pullMessage}</div>{/if}
		{#if updateTerminalVisible && updateSessionId && provider}
			<div class="mt-2 overflow-hidden rounded border border-[#4c566a] bg-[#2e3440]">
				<div class="flex items-center justify-between border-b border-[#4c566a] px-3 py-1"><span class="text-[10px] text-[#d8dee9]/60">Update Bootstrap</span>{#if updateFailed}<span class="text-[10px] text-[#bf616a]">Failed</span>{/if}{#if !updating}<button type="button" onclick={dismissUpdateTerminal} class="text-[10px] text-[#d8dee9]/60">Dismiss</button>{/if}</div>
				{#key updateSessionId}<div class="h-40"><TerminalTab sessionId={updateSessionId} command={provider.commands.update} kind="bootstrap" active={true} onExit={onUpdateExit} /></div>{/key}
			</div>
		{/if}
	</div>
{:else if !loading && !info?.installed && onBootstrap}
	<div class="flex items-center gap-3 rounded-xl border border-dashed border-[#d8dee9] px-4 py-3 dark:border-[#4c566a]"><Settings size={14} /><span class="text-xs text-[#4c566a] dark:text-[#d8dee9]/60">No bootstrap tool installed</span><button type="button" onclick={onBootstrap} class="ml-auto rounded-lg bg-[#88c0d0] px-3 py-1.5 text-xs text-[#2e3440]">Run Bootstrap</button></div>
{/if}
