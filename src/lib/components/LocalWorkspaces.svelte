<script lang="ts">
	import {
		ChevronRight,
		ChevronDown,
		FolderGit2,
		GitBranch,
		Tag,
		Play,
		Loader,
		RefreshCw,
		Trash2,
		Loader2,
		RotateCcw,
		Package,
		ArrowUpRight,
		TriangleAlert,
		Code,
		TerminalSquare
	} from 'lucide-svelte';
	import { untrack } from 'svelte';
	import { generateId } from '$lib/index';
	import type { ContainerData, LocalWorkspaceData, RepositoryData } from '$lib/types';
	import BootstrapStatus from './BootstrapStatus.svelte';
	import ServiceButton from './ServiceButton.svelte';
	import TerminalTab from './TerminalTab.svelte';

	interface Props {
		workspaceRoot: string;
		workspaces: LocalWorkspaceData[];
		containers: ContainerData[];
		hostname: string;
		vscodeSshHost: string;
		onOpenTerminal: (id: string, command: string, name: string, cwd: string) => void;
		onRefreshWorkspaces: () => void;
		onBootstrap?: () => void;
		onScrollToContainer?: (containerId: string) => void;
		onRefreshContainers?: () => Promise<void>;
	}

	let {
		workspaceRoot,
		workspaces: workspacesProp,
		containers,
		hostname,
		vscodeSshHost,
		onOpenTerminal,
		onRefreshWorkspaces,
		onBootstrap,
		onScrollToContainer,
		onRefreshContainers
	}: Props = $props();

	let workspaces = $state<LocalWorkspaceData[]>(untrack(() => workspacesProp));

	// Keep in sync with parent (active-build auto-polling, etc.)
	$effect(() => {
		workspaces = workspacesProp;
		// Clear optimistic building state once the workspace poll confirms a build session exists
		const confirmedPaths = new Set(
			workspacesProp
				.flatMap((ws) => ws.repos)
				.filter((r) => r.buildSession != null)
				.map((r) => r.path)
		);
		untrack(() => {
			if (buildingRepos.size > 0) {
				buildingRepos = new Set([...buildingRepos].filter((p) => !confirmedPaths.has(p)));
			}
		});
	});
	let expanded = $state<Set<string>>(new Set());
	let expandedRepos = $state<Set<string>>(new Set());
	let refreshing = $state(false);
	let buildingRepos = $state<Set<string>>(new Set());
	let deletingWorkspaces = $state<Set<string>>(new Set());

	// Branch picker state
	let branchPickerRepo = $state<string | null>(null);
	let branchPickerBranches = $state<string[]>([]);
	let branchPickerTags = $state<string[]>([]);
	let branchPickerLoading = $state(false);
	let checkoutInProgress = $state<string | null>(null);
	let startingRepos = $state<Set<string>>(new Set());

	/** Find matching container for a repo by localWorkspacePath */
	function findContainerForRepo(repoPath: string): ContainerData | undefined {
		return containers.find((c) => c.isDevcontainer && c.localWorkspacePath === repoPath);
	}

	async function refresh() {
		refreshing = true;
		try {
			onRefreshWorkspaces();
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

	function toggleRepoExpand(path: string) {
		const next = new Set(expandedRepos);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		expandedRepos = next;
	}

	async function buildAndStart(repoPath: string, repoName: string) {
		buildingRepos = new Set([...buildingRepos, repoPath]);
		try {
			const res = await fetch('/api/devcontainer/build', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ repoPath, repoName })
			});
			if (res.ok) {
				// Keep repoPath in buildingRepos — the $effect above will clear it once
				// the workspace poll confirms the build session has started.
				onRefreshWorkspaces();
			} else {
				buildingRepos = new Set([...buildingRepos].filter((p) => p !== repoPath));
			}
		} catch {
			buildingRepos = new Set([...buildingRepos].filter((p) => p !== repoPath));
		}
	}

	async function startContainer(repoPath: string, containerId: string) {
		startingRepos = new Set([...startingRepos, repoPath]);
		try {
			await fetch(`/api/containers/${containerId}/start`, { method: 'POST' });
			if (onRefreshContainers) await onRefreshContainers();
		} finally {
			startingRepos = new Set([...startingRepos].filter((p) => p !== repoPath));
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
		branchPickerTags = [];
		try {
			const res = await fetch(`/api/repos/branches?path=${encodeURIComponent(repoPath)}`);
			if (res.ok) {
				const data = await res.json();
				branchPickerBranches = data.branches;
				branchPickerTags = data.tags ?? [];
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
						r.path === repo.path
							? { ...r, currentBranch: data.currentBranch, currentTag: data.currentTag }
							: r
					)
				}));
			} else if (res.status === 409) {
				const data = await res.json();
				if (data.error === 'dirty') {
					const proceed = confirm('Working tree has uncommitted changes. Force checkout anyway?');
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
										? {
												...r,
												currentBranch: forceData.currentBranch,
												currentTag: forceData.currentTag
											}
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

	async function checkoutTag(repo: RepositoryData, tag: string) {
		if (tag === repo.currentTag) {
			branchPickerRepo = null;
			return;
		}
		checkoutInProgress = repo.path;
		try {
			const res = await fetch('/api/repos/checkout', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: repo.path, tag })
			});
			if (res.ok) {
				const data = await res.json();
				workspaces = workspaces.map((ws) => ({
					...ws,
					repos: ws.repos.map((r) =>
						r.path === repo.path
							? { ...r, currentBranch: data.currentBranch, currentTag: data.currentTag }
							: r
					)
				}));
			} else if (res.status === 409) {
				const data = await res.json();
				if (data.error === 'dirty') {
					const proceed = confirm('Working tree has uncommitted changes. Force checkout anyway?');
					if (proceed) {
						const forceRes = await fetch('/api/repos/checkout', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ path: repo.path, tag, force: true })
						});
						if (forceRes.ok) {
							const forceData = await forceRes.json();
							workspaces = workspaces.map((ws) => ({
								...ws,
								repos: ws.repos.map((r) =>
									r.path === repo.path
										? {
												...r,
												currentBranch: forceData.currentBranch,
												currentTag: forceData.currentTag
											}
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

	function runInTerminal(command: string, name: string) {
		const id = generateId();
		onOpenTerminal(id, command, name, workspaceRoot);
	}

	interface RerunSession {
		sessionId: string;
		visible: boolean;
		failed: boolean;
	}
	let rerunSessions = $state<Map<string, RerunSession>>(new Map());

	function rerunBootstrap(ws: LocalWorkspaceData) {
		const id = generateId();
		rerunSessions = new Map([...rerunSessions, [ws.id, { sessionId: id, visible: false, failed: false }]]);
		if (!expanded.has(ws.id)) toggleExpand(ws.id);
	}

	function toggleRerunTerminal(wsId: string) {
		const session = rerunSessions.get(wsId);
		if (!session) return;
		rerunSessions = new Map([...rerunSessions, [wsId, { ...session, visible: !session.visible }]]);
	}

	function dismissRerun(wsId: string) {
		const next = new Map(rerunSessions);
		next.delete(wsId);
		rerunSessions = next;
	}

	function onRerunExit(wsId: string, exitCode: number) {
		if (exitCode === 0) {
			// Success: auto-close terminal and refresh workspace data
			const next = new Map(rerunSessions);
			next.delete(wsId);
			rerunSessions = next;
			onRefreshWorkspaces();
		} else {
			// Failure: keep terminal open so the user can inspect the output
			const session = rerunSessions.get(wsId);
			if (!session) return;
			rerunSessions = new Map([...rerunSessions, [wsId, { ...session, visible: true, failed: true }]]);
		}
	}
</script>

<section>
	<div class="mb-4 flex items-center gap-2 border-b border-[#d8dee9] pb-2 dark:border-[#4c566a]">
		<FolderGit2 size={20} class="text-[#a3be8c] dark:text-[#a3be8c]" />
		<h2 class="text-xl font-extrabold text-[#2e3440] dark:text-[#eceff4]">Local Workspaces</h2>
		<span class="ml-1 text-sm font-medium text-[#4c566a] dark:text-[#d8dee9]/60"
			>({workspaceRoot})</span
		>
		<button
			onclick={refresh}
			disabled={refreshing}
			type="button"
			class="ml-auto rounded p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#2e3440] disabled:opacity-40 dark:text-[#d8dee9]/60 dark:hover:bg-[#4c566a] dark:hover:text-[#eceff4]"
			aria-label="Refresh workspaces"
		>
			<RefreshCw size={15} class={refreshing ? 'animate-spin' : ''} />
		</button>
	</div>

	<!-- Bootstrap tool info bar -->
	<div class="mb-4">
		<BootstrapStatus onRunInTerminal={runInTerminal} {onBootstrap} />
	</div>

	{#if workspaces.length === 0}
		<p class="text-[#4c566a] italic dark:text-[#d8dee9]/60">
			No workspaces found in {workspaceRoot}.
		</p>
	{:else}
		<div
			class="overflow-hidden rounded-xl border border-[#d8dee9] bg-white shadow-sm dark:border-[#4c566a] dark:bg-[#3b4252]"
		>
			{#each workspaces as ws (ws.id)}
				<!-- Task Workspace header -->
				<div
					class="flex w-full cursor-pointer items-center justify-between border-b border-[#d8dee9] px-5 py-3 transition-colors last:border-b-0 hover:bg-[#e5e9f0] dark:border-[#4c566a] dark:hover:bg-[#434c5e]"
					onclick={() => toggleExpand(ws.id)}
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') toggleExpand(ws.id);
					}}
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

						{#if ws.buildSession?.status === 'running'}
							<span
								class="flex items-center gap-1 rounded-full border border-[#ebcb8b]/30 bg-[#ebcb8b]/10 px-2 py-0.5 text-xs font-medium text-[#ebcb8b]"
							>
								<Loader size={10} class="animate-spin" />
								Building…
							</span>
						{:else if ws.buildSession?.status === 'failed'}
							<span
								class="flex items-center gap-1 rounded-full border border-[#bf616a]/30 bg-[#bf616a]/10 px-2 py-0.5 text-xs font-medium text-[#bf616a]"
							>
								<TriangleAlert size={10} />
								Build Failed
							</span>
						{/if}
						{#if ws.solutionMetadata}
							<span
								class="flex items-center gap-1 rounded-full border border-[#b48ead]/30 bg-[#b48ead]/10 px-2 py-0.5 text-xs font-medium text-[#b48ead]"
							>
								<Package size={10} />
								{ws.solutionMetadata.bootstrap_version}
							</span>
							<span
								class="rounded-full border border-[#81a1c1]/30 bg-[#81a1c1]/10 px-2 py-0.5 text-xs font-medium text-[#81a1c1]"
							>
								{ws.solutionMetadata.solution}
							</span>
						{/if}
					</div>
					<div class="flex items-center gap-2">
						{#if ws.solutionMetadata}
							{#if rerunSessions.has(ws.id) && !rerunSessions.get(ws.id)!.failed}
								<button
									disabled
									class="flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-[#b48ead]/30 bg-[#b48ead]/15 px-2.5 py-1 text-xs font-medium text-[#b48ead] opacity-75"
									type="button"
								>
									<Loader2 size={12} class="animate-spin" />
									Running…
								</button>
							{:else}
								<button
									onclick={(e) => {
										e.stopPropagation();
										rerunBootstrap(ws);
									}}
									class="flex items-center gap-1.5 rounded-lg border border-[#b48ead]/30 bg-[#b48ead]/15 px-2.5 py-1 text-xs font-medium text-[#b48ead] transition-colors hover:bg-[#b48ead]/25"
									type="button"
								>
									<RotateCcw size={12} />
									Rerun Bootstrap
								</button>
							{/if}
						{/if}
						<span
							class="rounded-full bg-[#d8dee9] px-2 py-0.5 text-xs font-medium text-[#4c566a] dark:bg-[#4c566a] dark:text-[#d8dee9]"
						>
							{ws.repos.length}
							{ws.repos.length === 1 ? 'Repo' : 'Repos'}
						</span>
						<button
							onclick={(e) => {
								e.stopPropagation();
								deleteWorkspace(ws);
							}}
							disabled={deletingWorkspaces.has(ws.id)}
							class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#bf616a] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9]/60 dark:hover:bg-[#3b4252] dark:hover:text-[#bf616a]"
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
					{#if ws.buildSession?.status === 'running' || ws.buildSession?.status === 'failed'}
						<!-- Inline terminal view for running/failed bootstrap -->
						<div class="border-b border-[#d8dee9] dark:border-[#4c566a]">
							{#if ws.buildSession.status === 'failed'}
								<div
									class="flex items-center gap-2 border-b border-[#bf616a]/20 bg-[#bf616a]/10 px-5 py-2 text-[#bf616a]"
								>
									<TriangleAlert size={14} />
									<span class="text-sm font-medium">Bootstrap failed</span>
								</div>
							{/if}
							<div class="h-64 overflow-hidden">
								<TerminalTab sessionId={ws.buildSession.id} active={true} />
							</div>
						</div>
					{:else}
						<div class="bg-[#f0f4f8] dark:bg-[#2e3440]">
							{#if rerunSessions.has(ws.id)}
								{@const rerunSession = rerunSessions.get(ws.id)!}
								<!-- Rerun progress / error row -->
								<div
									class="flex items-center gap-2 border-b px-5 py-1.5 {rerunSession.failed ? 'border-[#bf616a]/20 bg-[#bf616a]/10' : 'border-[#b48ead]/20 bg-[#b48ead]/10'}"
								>
									<button
										onclick={() => toggleRerunTerminal(ws.id)}
										type="button"
										class="shrink-0 rounded p-0.5 transition-colors {rerunSession.failed ? 'text-[#bf616a]/70 hover:bg-[#bf616a]/20 hover:text-[#bf616a]' : 'text-[#b48ead]/70 hover:bg-[#b48ead]/20 hover:text-[#b48ead]'}"
										aria-label={rerunSession.visible ? "Hide output" : "Show output"}
									>
										{#if rerunSession.visible}
											<ChevronDown size={13} />
										{:else}
											<ChevronRight size={13} />
										{/if}
									</button>
									{#if rerunSession.failed}
										<TriangleAlert size={12} class="text-[#bf616a]" />
										<span class="text-xs font-medium text-[#bf616a]">Bootstrap failed</span>
									{:else}
										<Loader2 size={12} class="animate-spin text-[#b48ead]" />
										<span class="text-xs font-medium text-[#b48ead]">Rerunning bootstrap…</span>
									{/if}
									<button
										onclick={() => dismissRerun(ws.id)}
										class="ml-auto rounded p-0.5 transition-colors {rerunSession.failed ? 'text-[#bf616a]/60 hover:bg-[#bf616a]/20 hover:text-[#bf616a]' : 'text-[#b48ead]/60 hover:bg-[#b48ead]/20 hover:text-[#b48ead]'}"
										type="button"
										aria-label={rerunSession.failed ? "Dismiss" : "Cancel"}
									>✕</button>
								</div>
								<!-- Terminal: always mounted to keep WebSocket alive; shown/hidden via display -->
								<div
									class="overflow-hidden {rerunSession.failed ? 'border-b border-[#bf616a]/20' : 'border-b border-[#b48ead]/20'}"
									style:display={rerunSession.visible ? "block" : "none"}
									style:height={rerunSession.visible ? "16rem" : "0"}
								>
									<TerminalTab
										sessionId={rerunSession.sessionId}
										command="devbootstrap --rerun -d {ws.path}"
										cwd={ws.path}
										active={rerunSession.visible}
										onExit={(code) => onRerunExit(ws.id, code)}
									/>
								</div>
							{/if}
							{#each ws.repos as repo (repo.path)}
								{@const matchedContainer = findContainerForRepo(repo.path)}
								{@const repoExpandable =
									repo.buildSession?.status === 'running' || repo.buildSession?.status === 'failed'}
								{@const folderUri = vscodeSshHost
									? `vscode://vscode-remote/ssh-remote+${vscodeSshHost}${repo.path}?windowId=_blank`
									: `vscode://file${repo.path}?windowId=_blank`}
								<div
									class="flex min-h-[2.5rem] items-center border-b border-[#d8dee9]/60 px-8 py-1.5 last:border-b-0 dark:border-[#4c566a]/60"
								>
									<!-- Repo name: takes available space -->
									<div class="flex w-[200px] min-w-0 shrink-0 items-center gap-2">
										{#if repoExpandable}
											<button
												onclick={() => toggleRepoExpand(repo.path)}
												type="button"
												aria-label={expandedRepos.has(repo.path)
													? 'Collapse build output'
													: 'Expand build output'}
												class="shrink-0 rounded p-0.5 text-[#4c566a] transition-colors hover:bg-[#d8dee9]/50 dark:text-[#d8dee9]/60 dark:hover:bg-[#4c566a]/50"
											>
												{#if expandedRepos.has(repo.path)}
													<ChevronDown size={14} />
												{:else}
													<ChevronRight size={14} />
												{/if}
											</button>
										{/if}
										<GitBranch size={14} class="shrink-0 text-[#81a1c1] dark:text-[#88c0d0]" />
										<span class="truncate text-sm font-medium text-[#2e3440] dark:text-[#d8dee9]"
											>{repo.name}</span
										>
									</div>

									<!-- Branch column: fixed width, left-aligned so branches line up -->
									<div class="flex w-[210px] shrink-0 items-center">
										{#if repo.currentBranch || repo.currentTag}
											<div class="relative">
												<button
													onclick={(e) => {
														e.stopPropagation();
														openBranchPicker(repo.path);
													}}
													class="flex items-center gap-1 rounded bg-[#e5e9f0] px-2 py-0.5 text-xs dark:bg-[#434c5e] {repo.currentTag
														? 'text-[#a3be8c] dark:text-[#a3be8c]'
														: 'text-[#5e81ac] dark:text-[#88c0d0]'} border border-[#d8dee9] transition-colors hover:bg-[#d8dee9] dark:border-[#4c566a] dark:hover:bg-[#4c566a]"
													type="button"
													title={repo.currentBranch ?? repo.currentTag}
												>
													{#if checkoutInProgress === repo.path}
														<Loader size={10} class="animate-spin" />
													{:else if repo.currentTag}
														<Tag size={10} />
													{/if}
													<span class="max-w-[180px] truncate"
														>{repo.currentBranch ?? repo.currentTag}</span
													>
													<ChevronDown size={10} />
												</button>
												{#if branchPickerRepo === repo.path}
													<div
														class="absolute top-full left-0 z-20 mt-1 max-h-60 w-56 overflow-y-auto rounded-lg border border-[#d8dee9] bg-white shadow-lg dark:border-[#4c566a] dark:bg-[#3b4252]"
													>
														{#if branchPickerLoading}
															<div class="px-3 py-2 text-xs text-[#4c566a] dark:text-[#d8dee9]/60">
																Loading…
															</div>
														{:else}
															{#if branchPickerBranches.length > 0}
																<div
																	class="border-b border-[#d8dee9] px-3 py-1.5 text-[10px] font-semibold tracking-wide text-[#4c566a] uppercase dark:border-[#4c566a] dark:text-[#d8dee9]/50"
																>
																	Branches
																</div>
																{#each branchPickerBranches as branch (branch)}
																	<button
																		onclick={() => checkoutBranch(repo, branch)}
																		class="w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-[#e5e9f0] dark:hover:bg-[#434c5e] {branch ===
																		repo.currentBranch
																			? 'font-bold text-[#88c0d0]'
																			: 'text-[#2e3440] dark:text-[#d8dee9]'}"
																		type="button"
																	>
																		{branch}
																		{#if branch === repo.currentBranch}
																			<span class="ml-1 text-[#a3be8c]">✓</span>
																		{/if}
																	</button>
																{/each}
															{/if}
															{#if branchPickerTags.length > 0}
																<div
																	class="border-b border-[#d8dee9] px-3 py-1.5 text-[10px] font-semibold tracking-wide text-[#4c566a] uppercase dark:border-[#4c566a] dark:text-[#d8dee9]/50 {branchPickerBranches.length >
																	0
																		? 'border-t'
																		: ''}"
																>
																	Tags
																</div>
																{#each branchPickerTags as tagName (tagName)}
																	<button
																		onclick={() => checkoutTag(repo, tagName)}
																		class="flex w-full items-center gap-1 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[#e5e9f0] dark:hover:bg-[#434c5e] {tagName ===
																		repo.currentTag
																			? 'font-bold text-[#a3be8c]'
																			: 'text-[#2e3440] dark:text-[#d8dee9]'}"
																		type="button"
																	>
																		<Tag size={10} class="shrink-0" />
																		{tagName}
																		{#if tagName === repo.currentTag}
																			<span class="ml-1 text-[#a3be8c]">✓</span>
																		{/if}
																	</button>
																{/each}
															{/if}
															{#if branchPickerBranches.length === 0 && branchPickerTags.length === 0}
																<div
																	class="px-3 py-2 text-xs text-[#4c566a] italic dark:text-[#d8dee9]/60"
																>
																	No branches or tags found
																</div>
															{/if}
														{/if}
													</div>
												{/if}
											</div>
										{/if}
									</div>

									<!-- Service buttons (when container exists) -->
									{#if matchedContainer && Object.keys(matchedContainer.ports).length > 0}
										<div class="mx-3 flex flex-wrap gap-1.5">
											{#each Object.entries(matchedContainer.ports) as [containerPort, hostPort] (containerPort)}
												<ServiceButton
													{containerPort}
													{hostPort}
													{hostname}
													running={matchedContainer.state === 'running'}
													variant="row"
													containerName={matchedContainer.name}
													projectName={matchedContainer.projectName}
													workspacePath={matchedContainer.localWorkspacePath}
													allPorts={matchedContainer.ports}
												/>
											{/each}
										</div>
									{/if}

									<!-- Action column: right-aligned -->
									<div class="ml-auto flex shrink-0 items-center justify-end gap-2">
										<div
											class="flex items-center rounded-xl border border-[#d8dee9] bg-[#eceff4] p-1 shadow-sm dark:border-[#434c5e] dark:bg-[#2e3440]"
										>
											<!-- VS Code: open folder via SSH or local file URI -->
											<a
												href={folderUri}
												rel="external"
												title="Open folder in VS Code"
												class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#5e81ac] dark:text-[#d8dee9]/60 dark:hover:bg-[#3b4252] dark:hover:text-[#81a1c1]"
											>
												<Code size={14} />
											</a>
											<!-- Terminal: open shell at repo path -->
											<button
												onclick={() => onOpenTerminal(generateId(), '', repo.name, repo.path)}
												title="Open terminal in folder"
												type="button"
												class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#88c0d0] dark:text-[#d8dee9]/60 dark:hover:bg-[#3b4252] dark:hover:text-[#88c0d0]"
											>
												<TerminalSquare size={14} />
											</button>
											{#if repo.hasDevcontainer}
												<div class="mx-0.5 h-4 w-px shrink-0 bg-[#d8dee9] dark:bg-[#434c5e]"></div>
												{#if matchedContainer && matchedContainer.state === 'running'}
													<button
														onclick={() => onScrollToContainer?.(matchedContainer.id)}
														class="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium whitespace-nowrap text-[#a3be8c] transition-colors hover:bg-[#e5e9f0] dark:hover:bg-[#3b4252]"
														type="button"
														title="Scroll to devcontainer"
													>
														<span class="inline-block h-1.5 w-1.5 rounded-full bg-[#a3be8c]"></span>
														Running
														<ArrowUpRight size={11} />
													</button>
												{:else if matchedContainer && matchedContainer.state !== 'running'}
													<button
														onclick={() => startContainer(repo.path, matchedContainer.id)}
														disabled={startingRepos.has(repo.path)}
														class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium whitespace-nowrap text-[#a3be8c] transition-colors hover:bg-[#e5e9f0] disabled:cursor-wait disabled:opacity-60 dark:hover:bg-[#3b4252]"
														type="button"
													>
														{#if startingRepos.has(repo.path)}
															<Loader size={12} class="animate-spin" />
															Starting…
														{:else}
															<Play size={12} class="fill-current" />
															Start
														{/if}
													</button>
												{:else if buildingRepos.has(repo.path) || repo.buildSession?.status === 'running'}
													<span
														class="flex items-center gap-1 px-2 py-1 text-xs font-medium whitespace-nowrap text-[#ebcb8b]"
													>
														<Loader size={12} class="animate-spin" />
														Building
													</span>
												{:else if repo.buildSession?.status === 'failed'}
													<span
														class="flex items-center gap-1 px-2 py-1 text-xs font-medium whitespace-nowrap text-[#bf616a]"
													>
														<TriangleAlert size={12} />
														Failed
													</span>
												{:else}
													<button
														onclick={() => buildAndStart(repo.path, repo.name)}
														class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium whitespace-nowrap text-[#81a1c1] transition-colors hover:bg-[#e5e9f0] dark:hover:bg-[#3b4252]"
														type="button"
													>
														<Play size={12} />
														Build &amp; Start
													</button>
												{/if}
											{/if}
										</div>
										{#if !repo.hasDevcontainer}
											<span
												class="text-xs whitespace-nowrap text-[#4c566a] italic dark:text-[#d8dee9]/40"
												>No config</span
											>
										{/if}
									</div>
								</div>
								{#if repoExpandable && repo.buildSession && expandedRepos.has(repo.path)}
									<div class="border-b border-[#d8dee9]/60 dark:border-[#4c566a]/60">
										{#if repo.buildSession.status === 'failed'}
											<div
												class="flex items-center gap-2 border-b border-[#bf616a]/20 bg-[#bf616a]/10 px-8 py-2 text-[#bf616a]"
											>
												<TriangleAlert size={14} />
												<span class="text-sm font-medium">Build failed</span>
											</div>
										{/if}
										<div class="h-64 overflow-hidden">
											<TerminalTab sessionId={repo.buildSession.id} active={true} />
										</div>
									</div>
								{/if}
							{/each}
						</div>
					{/if}
				{/if}
			{/each}
		</div>
	{/if}
</section>
