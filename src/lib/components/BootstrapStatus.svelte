<script lang="ts">
	import {
		Settings,
		GitBranch,
		ChevronDown,
		RefreshCw,
		ArrowDownToLine,
		RotateCcw,
		Loader,
		Play
	} from 'lucide-svelte';
	import type { BootstrapToolInfo, BootstrapProvider } from '$lib/types';

	interface Props {
		onRunInTerminal: (command: string, name: string) => void;
		onBootstrap?: () => void;
	}

	let { onRunInTerminal, onBootstrap }: Props = $props();

	let info = $state<BootstrapToolInfo | null>(null);
	let provider = $state<BootstrapProvider | null>(null);
	let loading = $state(true);
	let branchPickerOpen = $state(false);
	let pulling = $state(false);
	let checkingOut = $state(false);
	let pullMessage = $state<string | null>(null);

	$effect(() => {
		fetchBootstrapInfo();
	});

	async function fetchBootstrapInfo() {
		loading = true;
		try {
			const [infoRes, providerRes] = await Promise.all([
				fetch('/api/bootstrap'),
				fetch('/api/bootstrap/providers')
			]);
			if (infoRes.ok) info = await infoRes.json();
			if (providerRes.ok) {
				const providers = await providerRes.json();
				if (providers.length > 0) provider = providers[0];
			}
		} finally {
			loading = false;
		}
	}

	async function pullBranch() {
		pulling = true;
		pullMessage = null;
		try {
			const res = await fetch('/api/bootstrap/pull', { method: 'POST' });
			const data = await res.json();
			if (res.ok) {
				pullMessage = data.output || 'Pull complete';
				await fetchBootstrapInfo();
			} else {
				pullMessage = `Error: ${data.message || 'Pull failed'}`;
			}
		} catch {
			pullMessage = 'Error: Network request failed';
		} finally {
			pulling = false;
			setTimeout(() => (pullMessage = null), 5000);
		}
	}

	async function checkoutBranch(branch: string) {
		if (!info || branch === info.currentBranch) {
			branchPickerOpen = false;
			return;
		}
		checkingOut = true;
		try {
			const res = await fetch('/api/bootstrap/checkout', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ branch })
			});
			if (res.ok) {
				await fetchBootstrapInfo();
			}
		} finally {
			checkingOut = false;
			branchPickerOpen = false;
		}
	}

	function updateBootstrap() {
		if (!provider) return;
		onRunInTerminal(provider.commands.update, 'Update Bootstrap');
	}
</script>

{#if !loading && info?.installed}
	<div
		class="rounded-xl border border-[#d8dee9] bg-white px-4 py-3 shadow-sm dark:border-[#4c566a] dark:bg-[#3b4252]"
	>
		<div class="flex flex-wrap items-center gap-x-5 gap-y-2">
			<!-- Bootstrap label -->
			<div class="flex items-center gap-1.5">
				<Settings size={14} class="text-[#b48ead]" />
				<span class="text-xs font-bold text-[#2e3440] dark:text-[#eceff4]">Bootstrap</span>
				{#if provider}
					<span class="text-[10px] font-medium text-[#4c566a] dark:text-[#d8dee9]/50"
						>({provider.name})</span
					>
				{/if}
			</div>

			<!-- Version -->
			{#if info.version}
				<div class="flex items-center gap-1.5">
					<span class="text-[11px] text-[#4c566a] dark:text-[#d8dee9]/60">v</span>
					<span class="font-mono text-xs font-semibold text-[#2e3440] dark:text-[#eceff4]"
						>{info.version}</span
					>
				</div>
			{/if}

			<!-- Branch -->
			{#if info.currentBranch}
				<div class="relative flex items-center gap-1.5">
					<GitBranch size={12} class="text-[#81a1c1] dark:text-[#88c0d0]" />
					<button
						onclick={() => (branchPickerOpen = !branchPickerOpen)}
						class="flex items-center gap-1 rounded border border-[#d8dee9] bg-[#e5e9f0] px-2 py-0.5 text-xs font-semibold text-[#5e81ac] transition-colors hover:bg-[#d8dee9] dark:border-[#4c566a] dark:bg-[#434c5e] dark:text-[#88c0d0] dark:hover:bg-[#4c566a]"
						type="button"
					>
						{#if checkingOut}
							<Loader size={10} class="animate-spin" />
						{/if}
						{info.currentBranch}
						<ChevronDown size={10} />
					</button>
					{#if branchPickerOpen && info.availableBranches}
						<div
							class="absolute top-full left-0 z-20 mt-1 max-h-64 w-64 overflow-y-auto rounded-lg border border-[#d8dee9] bg-white shadow-lg dark:border-[#4c566a] dark:bg-[#3b4252]"
						>
							{#if info.availableBranches.length > 0}
								<div
									class="border-b border-[#d8dee9] px-3 py-1 text-[10px] font-semibold tracking-wide text-[#4c566a] uppercase dark:border-[#4c566a] dark:text-[#d8dee9]/50"
								>
									Local
								</div>
								{#each info.availableBranches as branch (branch)}
									<button
										onclick={() => checkoutBranch(branch)}
										class="w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-[#e5e9f0] dark:hover:bg-[#434c5e] {branch ===
										info.currentBranch
											? 'font-bold text-[#88c0d0]'
											: 'text-[#2e3440] dark:text-[#d8dee9]'}"
										type="button"
									>
										{branch}
										{#if branch === info.currentBranch}
											<span class="ml-1 text-[#a3be8c]">✓</span>
										{/if}
									</button>
								{/each}
							{/if}
							{#if info?.remoteBranches && info.remoteBranches.filter((b) => !info?.availableBranches?.includes(b)).length > 0}
								<div
									class="border-b border-[#d8dee9] px-3 py-1 text-[10px] font-semibold tracking-wide text-[#4c566a] uppercase dark:border-[#4c566a] dark:text-[#d8dee9]/50 {info.availableBranches &&
									info.availableBranches.length > 0
										? 'border-t'
										: ''}"
								>
									Remote
								</div>
								{#each info.remoteBranches.filter((b) => !info?.availableBranches?.includes(b)) as branch (branch)}
									<button
										onclick={() => checkoutBranch(branch)}
										class="w-full px-3 py-1.5 text-left text-xs text-[#4c566a] italic transition-colors hover:bg-[#e5e9f0] dark:text-[#d8dee9]/70 dark:hover:bg-[#434c5e]"
										type="button"
									>
										{branch}
										<span class="ml-1 text-[10px] text-[#4c566a] dark:text-[#d8dee9]/40"
											>origin</span
										>
									</button>
								{/each}
							{/if}
						</div>
					{/if}
				</div>
			{/if}

			<!-- Action buttons -->
			<div class="ml-auto flex items-center gap-2">
				{#if onBootstrap}
					<button
						onclick={onBootstrap}
						class="flex items-center gap-1.5 rounded-lg bg-[#88c0d0] px-3 py-1.5 text-xs font-semibold text-[#2e3440] transition-colors hover:bg-[#81a1c1]"
						type="button"
					>
						<Play size={12} />
						Run Bootstrap
					</button>
				{/if}
				<button
					onclick={pullBranch}
					disabled={pulling}
					class="flex items-center gap-1.5 rounded-lg border border-[#d8dee9] bg-[#e5e9f0] px-2.5 py-1.5 text-xs font-medium text-[#5e81ac] transition-colors hover:bg-[#d8dee9] disabled:opacity-50 dark:border-[#4c566a] dark:bg-[#434c5e] dark:text-[#88c0d0] dark:hover:bg-[#4c566a]"
					type="button"
				>
					{#if pulling}
						<Loader size={12} class="animate-spin" />
					{:else}
						<ArrowDownToLine size={12} />
					{/if}
					Pull
				</button>
				<button
					onclick={updateBootstrap}
					class="flex items-center gap-1.5 rounded-lg border border-[#b48ead]/30 bg-[#b48ead]/15 px-2.5 py-1.5 text-xs font-medium text-[#b48ead] transition-colors hover:bg-[#b48ead]/25"
					type="button"
				>
					<RotateCcw size={12} />
					Update
				</button>
				<button
					onclick={fetchBootstrapInfo}
					class="rounded p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#2e3440] dark:text-[#d8dee9]/60 dark:hover:bg-[#4c566a] dark:hover:text-[#eceff4]"
					type="button"
					aria-label="Refresh bootstrap info"
				>
					<RefreshCw size={13} />
				</button>
			</div>
		</div>

		{#if pullMessage}
			<div
				class="mt-2 rounded border border-[#d8dee9] bg-[#eceff4] px-3 py-2 font-mono text-xs text-[#4c566a] dark:border-[#4c566a] dark:bg-[#2e3440] dark:text-[#d8dee9]/80"
			>
				{pullMessage}
			</div>
		{/if}
	</div>
{:else if !loading && !info?.installed && onBootstrap}
	<div
		class="rounded-xl border border-dashed border-[#d8dee9] bg-[#eceff4]/50 px-4 py-3 dark:border-[#4c566a] dark:bg-[#2e3440]/50"
	>
		<div class="flex items-center gap-3">
			<Settings size={14} class="text-[#4c566a] dark:text-[#d8dee9]/40" />
			<span class="text-xs text-[#4c566a] dark:text-[#d8dee9]/60">No bootstrap tool installed</span>
			<button
				onclick={onBootstrap}
				class="ml-auto flex items-center gap-1.5 rounded-lg bg-[#88c0d0] px-3 py-1.5 text-xs font-semibold text-[#2e3440] transition-colors hover:bg-[#81a1c1]"
				type="button"
			>
				<Play size={12} />
				Run Bootstrap
			</button>
		</div>
	</div>
{/if}
