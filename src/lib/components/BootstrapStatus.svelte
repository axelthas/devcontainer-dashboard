<script lang="ts">
	import { Settings, GitBranch, ChevronDown, RefreshCw, ArrowDownToLine, RotateCcw, Loader } from 'lucide-svelte';
	import type { BootstrapToolInfo, BootstrapProvider } from '$lib/types';

	interface Props {
		onRunInTerminal: (command: string, name: string) => void;
	}

	let { onRunInTerminal }: Props = $props();

	let info = $state<BootstrapToolInfo | null>(null);
	let provider = $state<BootstrapProvider | null>(null);
	let loading = $state(true);
	let collapsed = $state(false);
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
	<section class="mb-6">
		<div class="flex items-center gap-2 mb-3 border-b border-[#d8dee9] dark:border-[#4c566a] pb-2">
			<Settings size={18} class="text-[#b48ead] dark:text-[#b48ead]" />
			<h2 class="text-lg font-extrabold text-[#2e3440] dark:text-[#eceff4]">Bootstrap Tool</h2>
			{#if provider}
				<span class="text-xs font-medium text-[#4c566a] dark:text-[#d8dee9]/60 ml-1">({provider.name})</span>
			{/if}
			<button
				onclick={() => (collapsed = !collapsed)}
				class="ml-auto p-1.5 rounded text-[#4c566a] dark:text-[#d8dee9]/60 hover:text-[#2e3440] dark:hover:text-[#eceff4] hover:bg-[#e5e9f0] dark:hover:bg-[#4c566a] transition-colors"
				type="button"
				aria-label="Toggle bootstrap panel"
			>
				<ChevronDown size={15} class="transition-transform {collapsed ? '-rotate-90' : ''}" />
			</button>
		</div>

		{#if !collapsed}
			<div class="rounded-xl border border-[#d8dee9] dark:border-[#4c566a] bg-white dark:bg-[#3b4252] shadow-sm p-4">
				<div class="flex flex-wrap items-center gap-x-6 gap-y-3">
					<!-- Version -->
					{#if info.version}
						<div class="flex items-center gap-2">
							<span class="text-xs font-medium text-[#4c566a] dark:text-[#d8dee9]/70">Version:</span>
							<span class="text-sm font-semibold text-[#2e3440] dark:text-[#eceff4] font-mono">{info.version}</span>
						</div>
					{/if}

					<!-- Branch -->
					{#if info.currentBranch}
						<div class="flex items-center gap-2 relative">
							<GitBranch size={14} class="text-[#81a1c1] dark:text-[#88c0d0]" />
							<span class="text-xs font-medium text-[#4c566a] dark:text-[#d8dee9]/70">Branch:</span>
							<button
								onclick={() => (branchPickerOpen = !branchPickerOpen)}
								class="flex items-center gap-1 text-sm font-semibold px-2 py-0.5 rounded bg-[#e5e9f0] dark:bg-[#434c5e] text-[#5e81ac] dark:text-[#88c0d0] hover:bg-[#d8dee9] dark:hover:bg-[#4c566a] transition-colors border border-[#d8dee9] dark:border-[#4c566a]"
								type="button"
							>
								{#if checkingOut}
									<Loader size={12} class="animate-spin" />
								{/if}
								{info.currentBranch}
								<ChevronDown size={12} />
							</button>
							{#if branchPickerOpen && info.availableBranches}
								<div class="absolute top-full left-0 mt-1 z-20 w-64 max-h-64 overflow-y-auto rounded-lg border border-[#d8dee9] dark:border-[#4c566a] bg-white dark:bg-[#3b4252] shadow-lg">
									{#if info.availableBranches.length > 0}
										<div class="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[#4c566a] dark:text-[#d8dee9]/50 border-b border-[#d8dee9] dark:border-[#4c566a]">Local</div>
										{#each info.availableBranches as branch}
											<button
												onclick={() => checkoutBranch(branch)}
												class="w-full text-left px-3 py-1.5 text-xs hover:bg-[#e5e9f0] dark:hover:bg-[#434c5e] transition-colors {branch === info.currentBranch ? 'font-bold text-[#88c0d0]' : 'text-[#2e3440] dark:text-[#d8dee9]'}"
												type="button"
											>
												{branch}
												{#if branch === info.currentBranch}
													<span class="text-[#a3be8c] ml-1">✓</span>
												{/if}
											</button>
										{/each}
									{/if}
									{#if info?.remoteBranches && info.remoteBranches.filter((b) => !info?.availableBranches?.includes(b)).length > 0}
										<div class="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[#4c566a] dark:text-[#d8dee9]/50 border-b border-[#d8dee9] dark:border-[#4c566a] {info.availableBranches && info.availableBranches.length > 0 ? 'border-t' : ''}">Remote</div>
										{#each info.remoteBranches.filter((b) => !info?.availableBranches?.includes(b)) as branch}
											<button
												onclick={() => checkoutBranch(branch)}
												class="w-full text-left px-3 py-1.5 text-xs hover:bg-[#e5e9f0] dark:hover:bg-[#434c5e] transition-colors text-[#4c566a] dark:text-[#d8dee9]/70 italic"
												type="button"
											>
												{branch}
												<span class="text-[10px] text-[#4c566a] dark:text-[#d8dee9]/40 ml-1">origin</span>
											</button>
										{/each}
									{/if}
								</div>
							{/if}
						</div>
					{/if}

					<!-- Path (small) -->
					<div class="flex items-center gap-2">
						<span class="text-xs font-medium text-[#4c566a] dark:text-[#d8dee9]/70">Path:</span>
						<span class="text-xs text-[#4c566a] dark:text-[#d8dee9]/60 font-mono">{info.repoPath}</span>
					</div>

					<!-- Action buttons -->
					<div class="flex items-center gap-2 ml-auto">
						<button
							onclick={pullBranch}
							disabled={pulling}
							class="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-[#e5e9f0] dark:bg-[#434c5e] text-[#5e81ac] dark:text-[#88c0d0] hover:bg-[#d8dee9] dark:hover:bg-[#4c566a] transition-colors border border-[#d8dee9] dark:border-[#4c566a] disabled:opacity-50"
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
							class="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-[#b48ead]/15 text-[#b48ead] hover:bg-[#b48ead]/25 transition-colors border border-[#b48ead]/30"
							type="button"
						>
							<RotateCcw size={12} />
							Update
						</button>
						<button
							onclick={fetchBootstrapInfo}
							class="p-1.5 rounded text-[#4c566a] dark:text-[#d8dee9]/60 hover:text-[#2e3440] dark:hover:text-[#eceff4] hover:bg-[#e5e9f0] dark:hover:bg-[#4c566a] transition-colors"
							type="button"
							aria-label="Refresh bootstrap info"
						>
							<RefreshCw size={13} />
						</button>
					</div>
				</div>

				{#if pullMessage}
					<div class="mt-3 text-xs font-mono px-3 py-2 rounded bg-[#eceff4] dark:bg-[#2e3440] text-[#4c566a] dark:text-[#d8dee9]/80 border border-[#d8dee9] dark:border-[#4c566a]">
						{pullMessage}
					</div>
				{/if}
			</div>
		{/if}
	</section>
{/if}
