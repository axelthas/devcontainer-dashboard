<script lang="ts">
	import { ChevronRight, ChevronDown, FolderGit2, GitBranch, Play, Loader, RefreshCw, Trash2, Loader2, RotateCcw, Package } from 'lucide-svelte';
	import { untrack } from 'svelte';
	import { generateId } from '$lib/index';
	import type { LocalWorkspaceData, RepositoryData } from '$lib/types';

	interface Props {
		workspaceRoot: string;
		workspaces: LocalWorkspaceData[];
		onOpenTerminal: (id: string, command: string, name: string, cwd: string) => void;
		onRunInTerminal: (command: string, name: string) => void;
	}

	let { workspaceRoot, workspaces: initialWorkspaces, onOpenTerminal, onRunInTerminal }: Props = $props();

	let workspaces = $state<LocalWorkspaceData[]>(untrack(() => initialWorkspaces));
	let expanded = $state<Set<string>>(new Set());
	let refreshing = $state(false);
	let buildingRepos = $state<Set<string>>(new Set());
	let deletingWorkspaces = $state<Set<string>>(new Set());

	// Branch picker state
	let branchPickerRepo = $state<string | null>(null);
	let branchPickerBranches = $state<string[]>([]);
	let branchPickerLoading = $state(false);
	let checkoutInProgress = $state<string | null>(null);

	async function refresh() {
		refreshing = true;
		try {
			const res = await fetch('/api/workspaces');
			if (res.ok) workspaces = await res.json();
		} finally {
			refreshing = false;
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
			const id = generateId();
			const command = `devcontainer up --workspace-folder ${repoPath}`;
			onOpenTerminal(id, command, repoName, repoPath);
		} finally {
			buildingRepos = new Set([...buildingRepos].filter((p) => p !== repoPath));
		}
	}

	async function deleteWorkspace(ws: LocalWorkspaceData) {
		if (!confirm(`Delete workspace "${ws.name}" at ${ws.path}? This cannot be undone.`)) return;
		deletingWorkspaces = new Set([...deletingWorkspaces, ws.id]);
		try {
			const res = await fetch('/api/workspaces', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: ws.path })
			});
			if (res.ok) {
				workspaces = workspaces.filter((w) => w.id !== ws.id);
			}
		} finally {
			deletingWorkspaces = new Set([...deletingWorkspaces].filter((id) => id !== ws.id));
		}
	}

	async function openBranchPicker(repoPath: string) {
		if (branchPickerRepo === repoPath) {
			branchPickerRepo = null;
			return;
		}
		branchPickerRepo = repoPath;
		branchPickerLoading = true;
		branchPickerBranches = [];
		try {
			const res = await fetch(`/api/repos/branches?path=${encodeURIComponent(repoPath)}`);
			if (res.ok) {
				const data = await res.json();
				branchPickerBranches = data.branches;
			}
		} finally {
			branchPickerLoading = false;
		}
	}

	async function checkoutBranch(repo: RepositoryData, branch: string) {
		if (branch === repo.currentBranch) {
			branchPickerRepo = null;
			return;
		}
		checkoutInProgress = repo.path;
		try {
			const res = await fetch('/api/repos/checkout', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: repo.path, branch })
			});
			if (res.ok) {
				const data = await res.json();
				// Update repo branch in local state
				workspaces = workspaces.map((ws) => ({
					...ws,
					repos: ws.repos.map((r) =>
						r.path === repo.path ? { ...r, currentBranch: data.currentBranch } : r
					)
				}));
			} else if (res.status === 409) {
				const data = await res.json();
				if (data.error === 'dirty') {
					const proceed = confirm(
						'Working tree has uncommitted changes. Force checkout anyway?'
					);
					if (proceed) {
						const forceRes = await fetch('/api/repos/checkout', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ path: repo.path, branch, force: true })
						});
						if (forceRes.ok) {
							const forceData = await forceRes.json();
							workspaces = workspaces.map((ws) => ({
								...ws,
								repos: ws.repos.map((r) =>
									r.path === repo.path
										? { ...r, currentBranch: forceData.currentBranch }
										: r
								)
							}));
						}
					}
				}
			}
		} finally {
			checkoutInProgress = null;
			branchPickerRepo = null;
		}
	}

	function rerunBootstrap(ws: LocalWorkspaceData) {
		const command = `devbootstrap --rerun -d ${ws.path}`;
		const id = generateId();
		onOpenTerminal(id, command, `Rerun: ${ws.name}`, ws.path);
	}
</script>

<section>
	<div class="flex items-center gap-2 mb-6 border-b border-[#d8dee9] dark:border-[#4c566a] pb-2">
		<FolderGit2 size={20} class="text-[#a3be8c] dark:text-[#a3be8c]" />
		<h2 class="text-xl font-extrabold text-[#2e3440] dark:text-[#eceff4]">Local Workspaces</h2>
		<span class="text-sm font-medium text-[#4c566a] dark:text-[#d8dee9]/60 ml-1"
			>({workspaceRoot})</span
		>
		<button
			onclick={refresh}
			disabled={refreshing}
			type="button"
			class="ml-auto p-1.5 rounded text-[#4c566a] dark:text-[#d8dee9]/60 hover:text-[#2e3440] dark:hover:text-[#eceff4] hover:bg-[#e5e9f0] dark:hover:bg-[#4c566a] transition-colors disabled:opacity-40"
			aria-label="Refresh workspaces"
		>
			<RefreshCw size={15} class={refreshing ? 'animate-spin' : ''} />
		</button>
	</div>

	{#if workspaces.length === 0}
		<p class="text-[#4c566a] dark:text-[#d8dee9]/60 italic">
			No workspaces found in {workspaceRoot}.
		</p>
	{:else}
		<div
			class="rounded-xl border border-[#d8dee9] dark:border-[#4c566a] bg-white dark:bg-[#3b4252] shadow-sm overflow-hidden"
		>
			{#each workspaces as ws (ws.id)}
				<!-- Task Workspace header -->
				<div
					class="w-full flex items-center justify-between px-5 py-3 hover:bg-[#e5e9f0] dark:hover:bg-[#434c5e] transition-colors border-b border-[#d8dee9] dark:border-[#4c566a] last:border-b-0 cursor-pointer"
					onclick={() => toggleExpand(ws.id)}
					onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleExpand(ws.id); }}
					role="button"
					tabindex="0"
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
					<div class="flex items-center gap-2">
						<span
							class="text-xs font-medium bg-[#d8dee9] dark:bg-[#4c566a] text-[#4c566a] dark:text-[#d8dee9] px-2 py-0.5 rounded-full"
						>
							{ws.repos.length}
							{ws.repos.length === 1 ? 'Repo' : 'Repos'}
						</span>
						<button
							onclick={(e) => { e.stopPropagation(); deleteWorkspace(ws); }}
							disabled={deletingWorkspaces.has(ws.id)}
							class="p-1.5 rounded-lg transition-colors text-[#4c566a] dark:text-[#d8dee9]/60 hover:text-[#bf616a] dark:hover:text-[#bf616a] hover:bg-[#e5e9f0] dark:hover:bg-[#3b4252] disabled:opacity-50 disabled:cursor-not-allowed"
							title="Delete workspace"
							type="button"
						>
							{#if deletingWorkspaces.has(ws.id)}
								<Loader2 size={14} class="animate-spin" />
							{:else}
								<Trash2 size={14} />
							{/if}
						</button>
					</div>
				</div>

				{#if expanded.has(ws.id)}
					<div class="bg-[#f0f4f8] dark:bg-[#2e3440]">
						{#if ws.solutionMetadata}
							<!-- Solution metadata bar -->
							<div class="px-8 py-3 border-b border-[#d8dee9]/60 dark:border-[#4c566a]/60 flex flex-wrap items-center gap-x-5 gap-y-2">
								<div class="flex items-center gap-1.5">
									<Package size={13} class="text-[#b48ead] dark:text-[#b48ead]" />
									<span class="text-xs font-medium text-[#4c566a] dark:text-[#d8dee9]/70">Bootstrap:</span>
									<span class="text-xs font-semibold text-[#2e3440] dark:text-[#eceff4]">{ws.solutionMetadata.bootstrap_version}</span>
								</div>
								<div class="flex items-center gap-1.5">
									<span class="text-xs font-medium text-[#4c566a] dark:text-[#d8dee9]/70">Solution:</span>
									<span class="text-xs font-semibold text-[#2e3440] dark:text-[#eceff4]">{ws.solutionMetadata.solution}</span>
								</div>
								<div class="flex items-center gap-1.5">
									<span class="text-xs font-medium text-[#4c566a] dark:text-[#d8dee9]/70">Projects:</span>
									<span class="text-xs font-semibold text-[#2e3440] dark:text-[#eceff4]">{ws.solutionMetadata.projects.length}</span>
								</div>
								<button
									onclick={() => rerunBootstrap(ws)}
									class="ml-auto flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-lg bg-[#b48ead]/15 text-[#b48ead] hover:bg-[#b48ead]/25 transition-colors border border-[#b48ead]/30"
									type="button"
								>
									<RotateCcw size={12} />
									Rerun Bootstrap
								</button>
							</div>
						{/if}
						{#each ws.repos as repo}
							<div
								class="flex items-center px-8 py-2.5 border-b border-[#d8dee9]/60 dark:border-[#4c566a]/60 last:border-b-0"
							>
								<div class="flex items-center gap-2 min-w-0 flex-grow">
									<GitBranch size={14} class="shrink-0 text-[#81a1c1] dark:text-[#88c0d0]" />
									<span class="font-medium text-sm text-[#2e3440] dark:text-[#d8dee9] truncate"
										>{repo.name}</span
									>
								</div>

								<div class="shrink-0 flex items-center gap-3 ml-4">
									{#if repo.hasDevcontainer}
										<span
											class="text-xs px-1.5 py-0.5 rounded bg-[#88c0d0]/20 text-[#5e81ac] dark:text-[#88c0d0] border border-[#88c0d0]/30"
										>
											devcontainer
										</span>
									{/if}
									{#if repo.currentBranch}
										<div class="relative">
											<button
												onclick={() => openBranchPicker(repo.path)}
												class="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-[#e5e9f0] dark:bg-[#434c5e] text-[#5e81ac] dark:text-[#88c0d0] hover:bg-[#d8dee9] dark:hover:bg-[#4c566a] transition-colors border border-[#d8dee9] dark:border-[#4c566a]"
												type="button"
												title="Switch branch"
											>
												{#if checkoutInProgress === repo.path}
													<Loader size={10} class="animate-spin" />
												{/if}
												<span class="max-w-[120px] truncate">{repo.currentBranch}</span>
												<ChevronDown size={10} />
											</button>
											{#if branchPickerRepo === repo.path}
												<div class="absolute top-full right-0 mt-1 z-20 w-56 max-h-48 overflow-y-auto rounded-lg border border-[#d8dee9] dark:border-[#4c566a] bg-white dark:bg-[#3b4252] shadow-lg">
													{#if branchPickerLoading}
														<div class="px-3 py-2 text-xs text-[#4c566a] dark:text-[#d8dee9]/60">Loading…</div>
													{:else}
														{#each branchPickerBranches as branch}
															<button
																onclick={() => checkoutBranch(repo, branch)}
																class="w-full text-left px-3 py-1.5 text-xs hover:bg-[#e5e9f0] dark:hover:bg-[#434c5e] transition-colors {branch === repo.currentBranch ? 'font-bold text-[#88c0d0]' : 'text-[#2e3440] dark:text-[#d8dee9]'}"
																type="button"
															>
																{branch}
																{#if branch === repo.currentBranch}
																	<span class="text-[#a3be8c] ml-1">✓</span>
																{/if}
															</button>
														{/each}
														{#if branchPickerBranches.length === 0}
															<div class="px-3 py-2 text-xs text-[#4c566a] dark:text-[#d8dee9]/60 italic">No branches found</div>
														{/if}
													{/if}
												</div>
											{/if}
										</div>
									{/if}
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
