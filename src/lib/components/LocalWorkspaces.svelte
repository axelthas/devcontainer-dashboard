<script lang="ts">
	import { ChevronRight, ChevronDown, FolderGit2, GitBranch, Play, Loader } from 'lucide-svelte';
	import type { LocalWorkspaceData } from '$lib/types';

	interface Props {
		workspaceRoot: string;
		onOpenTerminal: (id: string, command: string, name: string, cwd: string) => void;
	}

	let { workspaceRoot, onOpenTerminal }: Props = $props();

	let workspaces = $state<LocalWorkspaceData[]>([]);
	let expanded = $state<Set<string>>(new Set());
	let loading = $state(false);
	let buildingRepos = $state<Set<string>>(new Set());

	$effect(() => {
		fetchWorkspaces();
	});

	async function fetchWorkspaces() {
		loading = true;
		try {
			const res = await fetch('/api/workspaces');
			if (res.ok) workspaces = await res.json();
		} finally {
			loading = false;
		}
	}

	function toggleExpand(id: string) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}

	async function buildAndStart(repoPath: string, repoName: string) {
		buildingRepos = new Set([...buildingRepos, repoPath]);
		try {
			const id = crypto.randomUUID();
			const command = `devcontainer up --workspace-folder ${repoPath}`;
			onOpenTerminal(id, command, repoName, repoPath);
		} finally {
			buildingRepos = new Set([...buildingRepos].filter((p) => p !== repoPath));
		}
	}
</script>

<section>
	<div class="flex items-center gap-2 mb-6 border-b border-[#d8dee9] dark:border-[#4c566a] pb-2">
		<FolderGit2 size={20} class="text-[#a3be8c] dark:text-[#a3be8c]" />
		<h2 class="text-xl font-extrabold text-[#2e3440] dark:text-[#eceff4]">Local Workspaces</h2>
		<span class="text-sm font-medium text-[#4c566a] dark:text-[#d8dee9]/60 ml-1"
			>({workspaceRoot})</span
		>
	</div>

	{#if loading}
		<div class="flex items-center gap-2 text-[#4c566a] dark:text-[#d8dee9]/60 italic">
			<Loader size={16} class="animate-spin" />
			<span>Scanning workspaces…</span>
		</div>
	{:else if workspaces.length === 0}
		<p class="text-[#4c566a] dark:text-[#d8dee9]/60 italic">
			No workspaces found in {workspaceRoot}.
		</p>
	{:else}
		<div
			class="rounded-xl border border-[#d8dee9] dark:border-[#4c566a] bg-white dark:bg-[#3b4252] shadow-sm overflow-hidden"
		>
			{#each workspaces as ws (ws.id)}
				<!-- Task Workspace header -->
				<button
					class="w-full flex items-center justify-between px-5 py-3 hover:bg-[#e5e9f0] dark:hover:bg-[#434c5e] transition-colors border-b border-[#d8dee9] dark:border-[#4c566a] last:border-b-0"
					onclick={() => toggleExpand(ws.id)}
					type="button"
				>
					<div class="flex items-center gap-3">
						{#if expanded.has(ws.id)}
							<ChevronDown size={16} class="text-[#4c566a] dark:text-[#d8dee9]/60" />
						{:else}
							<ChevronRight size={16} class="text-[#4c566a] dark:text-[#d8dee9]/60" />
						{/if}
						<span class="font-semibold text-[#2e3440] dark:text-[#eceff4]">{ws.name}</span>
						<span class="text-xs text-[#4c566a] dark:text-[#d8dee9]/60">{ws.path}</span>
					</div>
					<span
						class="text-xs font-medium bg-[#d8dee9] dark:bg-[#4c566a] text-[#4c566a] dark:text-[#d8dee9] px-2 py-0.5 rounded-full"
					>
						{ws.repos.length}
						{ws.repos.length === 1 ? 'Repo' : 'Repos'}
					</span>
				</button>

				{#if expanded.has(ws.id)}
					<div class="bg-[#f0f4f8] dark:bg-[#2e3440]">
						{#each ws.repos as repo}
							<div
								class="flex items-center justify-between px-8 py-2.5 border-b border-[#d8dee9]/60 dark:border-[#4c566a]/60 last:border-b-0"
							>
								<div class="flex items-center gap-2 min-w-0">
									<GitBranch size={14} class="shrink-0 text-[#81a1c1] dark:text-[#88c0d0]" />
									<span class="font-medium text-sm text-[#2e3440] dark:text-[#d8dee9] truncate"
										>{repo.name}</span
									>
									{#if repo.hasDevcontainer}
										<span
											class="text-xs px-1.5 py-0.5 rounded bg-[#88c0d0]/20 text-[#5e81ac] dark:text-[#88c0d0] border border-[#88c0d0]/30 shrink-0"
										>
											.devcontainer
										</span>
									{/if}
								</div>

								<div class="shrink-0 ml-4">
									{#if !repo.hasDevcontainer}
										<span class="text-xs text-[#4c566a] dark:text-[#d8dee9]/40 italic"
											>No configuration</span
										>
									{:else if repo.isRunning}
										<span
											class="text-xs font-medium text-[#a3be8c] flex items-center gap-1.5 bg-[#a3be8c]/10 px-2 py-1 rounded-full border border-[#a3be8c]/20"
										>
											<span class="w-1.5 h-1.5 rounded-full bg-[#a3be8c] inline-block"></span>
											Active Above
										</span>
									{:else}
										<button
											onclick={() => buildAndStart(repo.path, repo.name)}
											disabled={buildingRepos.has(repo.path)}
											class="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-[#5e81ac] hover:bg-[#81a1c1] text-white transition-colors disabled:opacity-60 disabled:cursor-wait"
											type="button"
										>
											{#if buildingRepos.has(repo.path)}
												<Loader size={12} class="animate-spin" />
												Starting…
											{:else}
												<Play size={12} />
												Build &amp; Start
											{/if}
										</button>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</section>
