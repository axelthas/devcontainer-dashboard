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
		Loader2,
		RotateCcw,
		Package,
		ArrowUpRight,
		TriangleAlert,
		FileText,
		X,
		Boxes
	} from 'lucide-svelte';
	import { onDestroy, untrack } from 'svelte';
	import {
		errorMessage,
		latestRequest,
		requestJson,
		RequestError as RequestFailure
	} from '$lib/requests';
	import RequestError from './RequestError.svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { generateId } from '$lib/index';
	import type { ContainerData, LocalWorkspaceData, RepositoryData } from '$lib/types';
	import BootstrapStatus from './BootstrapStatus.svelte';
	import LogViewer from './LogViewer.svelte';
	import ServiceButton from './ServiceButton.svelte';
	import OpenWithMenu from './OpenWithMenu.svelte';
	import WorkspaceMoreMenu from './WorkspaceMoreMenu.svelte';
	import ComposeSandboxPanel from './ComposeSandboxPanel.svelte';
	import { resolve } from '$app/paths';
	import TerminalTab from './TerminalTab.svelte';

	interface Props {
		workspaceRoot: string;
		workspaces: LocalWorkspaceData[];
		containers: ContainerData[];
		vscodeSshHost: string;
		serviceProxyEnabled?: boolean;
		onOpenTerminal: (id: string, command: string, name: string, cwd: string) => void;
		onRefreshWorkspaces: () => Promise<void>;
		onBootstrap?: () => void;
		onScrollToContainer?: (containerId: string) => void;
		onRefreshContainers?: () => Promise<void>;
	}

	let {
		workspaceRoot,
		workspaces: workspacesProp,
		containers,
		vscodeSshHost,
		serviceProxyEnabled,
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
	let expanded = new SvelteSet<string>();
	let expandedRepos = new SvelteSet<string>();
	// Repositories whose Compose sandbox panel is open
	const sandboxRepos = new SvelteSet<string>();
	let refreshing = $state(false);
	let buildingRepos = $state<Set<string>>(new Set());
	let deletingWorkspaces = $state<Set<string>>(new Set());

	// Read-only viewer for the kept log of a failed build or bootstrap run
	let logViewer = $state<{ id: string; title: string } | null>(null);

	// Branch picker state
	let branchPickerRepo = $state<string | null>(null);
	let branchPickerBranches = $state<string[]>([]);
	let branchPickerTags = $state<string[]>([]);
	let branchPickerLoading = $state(false);
	let checkoutInProgress = $state<string | null>(null);
	let startingRepos = $state<Set<string>>(new Set());
	let refreshError = $state('');
	let operationErrors = $state<Record<string, string>>({});
	const pendingOperations = new SvelteSet<string>();
	const branchReads = latestRequest();
	let branchRevision = 0;
	let refreshCount = 0;
	let disposed = false;
	onDestroy(() => {
		disposed = true;
		branchReads.cancel();
	});

	// Poll while a Compose run is active, so a collapsed row still shows completion.
	const hasActiveComposeRuns = $derived(
		workspaces.some((ws) => ws.repos.some((repo) => repo.composeRun?.status === 'running'))
	);

	$effect(() => {
		if (!hasActiveComposeRuns) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			await onRefreshWorkspaces().catch(() => {});
			if (!stopped) timer = setTimeout(poll, 3000);
		}
		timer = setTimeout(poll, 3000);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	});

	/** Catch event-handler failures and keep the error next to its workspace or repository. */
	async function operate(key: string, work: () => Promise<void>) {
		if (pendingOperations.has(key)) return;
		pendingOperations.add(key);
		operationErrors[key] = '';
		try {
			await work();
		} catch (cause) {
			if (!disposed) operationErrors[key] = errorMessage(cause);
		} finally {
			pendingOperations.delete(key);
		}
	}

	/** Refresh notifications from process exits must not create unhandled rejections. */
	function refreshAfterExit() {
		void refresh();
	}

	// Config picker state for repos with multiple devcontainer.json files
	let configPickerRepo = $state<string | null>(null);
	let selectedConfigs = $state<SvelteMap<string, string>>(
		(() => {
			if (typeof localStorage === 'undefined') return new SvelteMap();
			try {
				const raw = localStorage.getItem('devcontainer-config-selections');
				return raw ? new SvelteMap(JSON.parse(raw) as [string, string][]) : new SvelteMap();
			} catch {
				return new SvelteMap();
			}
		})()
	);

	function getConfigDisplayName(configPath: string): string {
		// '.devcontainer/rocky8/devcontainer.json' → 'rocky8'
		// '.devcontainer/devcontainer.json' or '.devcontainer.json' → 'default'
		const parts = configPath.split('/');
		return parts.length === 3 ? parts[1] : 'default';
	}

	function getEffectiveConfig(repo: RepositoryData): string | undefined {
		if (!repo.devcontainerConfigs?.length) return undefined;
		return selectedConfigs.get(repo.path) ?? repo.devcontainerConfigs[0];
	}

	function selectConfig(repoPath: string, configPath: string) {
		selectedConfigs.set(repoPath, configPath);
		configPickerRepo = null;
		try {
			localStorage.setItem('devcontainer-config-selections', JSON.stringify([...selectedConfigs]));
		} catch {
			// ignore storage errors
		}
	}

	/** Find matching container for a repo by localWorkspacePath */
	function findContainerForRepo(repoPath: string): ContainerData | undefined {
		return containers.find((c) => c.isDevcontainer && c.localWorkspacePath === repoPath);
	}

	async function refresh() {
		refreshCount++;
		refreshing = true;
		refreshError = '';
		try {
			await onRefreshWorkspaces();
		} catch (cause) {
			if (!disposed) refreshError = `Workspace status may be outdated. ${errorMessage(cause)}`;
		} finally {
			refreshCount--;
			if (!disposed) refreshing = refreshCount > 0;
		}
	}

	function toggleExpand(id: string) {
		if (expanded.has(id)) expanded.delete(id);
		else expanded.add(id);
	}

	function toggleRepoExpand(path: string) {
		if (expandedRepos.has(path)) expandedRepos.delete(path);
		else expandedRepos.add(path);
	}

	/** Open or close the Compose sandbox panel; closing never stops a running action. */
	function toggleSandbox(path: string) {
		if (sandboxRepos.has(path)) sandboxRepos.delete(path);
		else sandboxRepos.add(path);
	}

	function openLog(id: string, title: string) {
		logViewer = { id, title };
	}

	function openBuildLog(repo: RepositoryData) {
		if (repo.buildSession) openLog(repo.buildSession.id, `${repo.name} build log`);
	}

	function openBootstrapLog(ws: LocalWorkspaceData) {
		if (ws.buildSession) openLog(ws.buildSession.id, `${ws.name} bootstrap log`);
	}

	// Cancels a running build, or dismisses a failed build and deletes its log.
	async function dismissBuild(buildId: string) {
		await operate(buildId, async () => {
			await requestJson('/api/devcontainer/build', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: buildId })
			});
			await onRefreshWorkspaces();
		});
	}

	// Dismisses a failed bootstrap run and deletes its log.
	async function dismissBootstrapRun(runId: string) {
		await operate(runId, async () => {
			await requestJson('/api/bootstrap/run', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: runId })
			});
			await onRefreshWorkspaces();
		});
	}

	async function buildAndStart(repoPath: string, repoName: string, configPath?: string) {
		if (pendingOperations.has(repoPath)) return;
		buildingRepos = new Set([...buildingRepos, repoPath]);
		await operate(repoPath, async () => {
			try {
				await requestJson('/api/devcontainer/build', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ repoPath, repoName, ...(configPath ? { configPath } : {}) })
				});
				await onRefreshWorkspaces();
			} finally {
				buildingRepos = new Set([...buildingRepos].filter((p) => p !== repoPath));
			}
		});
	}

	async function startContainer(repoPath: string, containerId: string) {
		if (pendingOperations.has(repoPath)) return;
		startingRepos = new Set([...startingRepos, repoPath]);
		await operate(repoPath, async () => {
			try {
				await requestJson(`/api/containers/${containerId}/start`, { method: 'POST' });
				if (onRefreshContainers) await onRefreshContainers();
			} finally {
				startingRepos = new Set([...startingRepos].filter((p) => p !== repoPath));
			}
		});
	}

	async function deleteWorkspace(ws: LocalWorkspaceData) {
		if (pendingOperations.has(ws.id)) return;
		if (!confirm(`Delete workspace "${ws.name}" at ${ws.path}? This cannot be undone.`)) return;
		deletingWorkspaces = new Set([...deletingWorkspaces, ws.id]);
		await operate(ws.id, async () => {
			try {
				await requestJson('/api/workspaces', {
					method: 'DELETE',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ path: ws.path })
				});
				workspaces = workspaces.filter((w) => w.id !== ws.id);
				await onRefreshWorkspaces();
			} finally {
				deletingWorkspaces = new Set([...deletingWorkspaces].filter((id) => id !== ws.id));
			}
		});
	}

	async function openBranchPicker(repoPath: string) {
		const revision = ++branchRevision;
		if (branchPickerRepo === repoPath) {
			branchReads.cancel();
			branchPickerRepo = null;
			return;
		}
		branchPickerRepo = repoPath;
		branchPickerLoading = true;
		branchPickerBranches = [];
		branchPickerTags = [];
		operationErrors[repoPath] = '';
		try {
			await branchReads.run(
				(signal) =>
					requestJson<{ branches: string[]; tags?: string[] }>(
						`/api/repos/branches?path=${encodeURIComponent(repoPath)}`,
						{ signal }
					),
				(data) => {
					branchPickerBranches = data.branches;
					branchPickerTags = data.tags ?? [];
				}
			);
		} catch (cause) {
			if (!disposed && branchPickerRepo === repoPath)
				operationErrors[repoPath] = errorMessage(cause);
		} finally {
			if (!disposed && revision === branchRevision) branchPickerLoading = false;
		}
	}

	async function checkoutBranch(repo: RepositoryData, branch: string) {
		await checkoutRef(repo, { branch }, branch === repo.currentBranch);
	}

	async function checkoutTag(repo: RepositoryData, tag: string) {
		await checkoutRef(repo, { tag }, tag === repo.currentTag);
	}

	/** Share branch/tag failure handling while preserving the explicit dirty-tree confirmation. */
	async function checkoutRef(
		repo: RepositoryData,
		ref: { branch?: string; tag?: string },
		current: boolean
	) {
		if (pendingOperations.has(repo.path)) return;
		if (current) {
			branchPickerRepo = null;
			return;
		}
		branchReads.cancel();
		checkoutInProgress = repo.path;
		await operate(repo.path, async () => {
			const checkout = (force = false) =>
				requestJson<{ currentBranch?: string; currentTag?: string }>('/api/repos/checkout', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ path: repo.path, ...ref, force })
				});
			try {
				let data;
				try {
					data = await checkout();
				} catch (cause) {
					if (!(cause instanceof RequestFailure) || cause.status !== 409) throw cause;
					if (!confirm('Working tree has uncommitted changes. Force checkout anyway?')) return;
					data = await checkout(true);
				}
				if (disposed) return;
				workspaces = workspaces.map((ws) => ({
					...ws,
					repos: ws.repos.map((r) => (r.path === repo.path ? { ...r, ...data } : r))
				}));
				await onRefreshWorkspaces();
			} finally {
				if (!disposed) {
					checkoutInProgress = null;
					branchPickerRepo = null;
				}
			}
		});
	}

	interface RerunSession {
		sessionId: string;
		visible: boolean;
	}
	let rerunSessions = new SvelteMap<string, RerunSession>();

	function rerunBootstrap(ws: LocalWorkspaceData) {
		const id = generateId();
		rerunSessions.set(ws.id, { sessionId: id, visible: false });
		if (!expanded.has(ws.id)) toggleExpand(ws.id);
	}

	function toggleRerunTerminal(wsId: string) {
		const session = rerunSessions.get(wsId);
		if (!session) return;
		rerunSessions.set(wsId, { ...session, visible: !session.visible });
	}

	// Cancel stops the rerun process; it does not only hide the terminal.
	async function dismissRerun(wsId: string) {
		const session = rerunSessions.get(wsId);
		if (!session) return;
		await operate(wsId, async () => {
			await requestJson('/api/terminal/sessions', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: session.sessionId })
			});
			if (rerunSessions.get(wsId)?.sessionId === session.sessionId) rerunSessions.delete(wsId);
			await onRefreshWorkspaces();
		});
	}

	// Close the rerun terminal when the process exits, whatever the exit code.
	function onRerunExit(wsId: string) {
		rerunSessions.delete(wsId);
		refreshAfterExit();
	}
</script>

<section>
	<div class="mb-4 flex items-center gap-2 border-b border-[#d8dee9] pb-2 dark:border-[#4c566a]">
		<FolderGit2 size={20} class="text-[#a3be8c] dark:text-[#a3be8c]" />
		<h2 class="text-xl font-extrabold text-[#2e3440] dark:text-[#eceff4]">Local Workspaces</h2>
		<a href={resolve('/ai')} class="text-sm text-[#5e81ac] underline dark:text-[#88c0d0]"
			>AI folders</a
		>
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
	<RequestError message={refreshError} onRetry={() => void refresh()} />
	<div class="mb-4">
		<BootstrapStatus {onBootstrap} />
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
					class="flex w-full cursor-pointer flex-wrap items-center justify-between gap-3 border-b border-[#d8dee9] px-5 py-2 transition-colors last:border-b-0 hover:bg-[#e5e9f0] dark:border-[#4c566a] dark:hover:bg-[#434c5e]"
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
						<span class="text-sm whitespace-nowrap text-[#4c566a] dark:text-[#d8dee9]/60"
							>· {ws.repos.length} {ws.repos.length === 1 ? 'repo' : 'repos'}</span
						>

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
					<!-- One compact group: frequent Open with first, rare/destructive actions under ⋯ -->
					<div
						class="flex items-center rounded-xl border border-[#d8dee9] bg-[#eceff4] p-1 shadow-sm dark:border-[#434c5e] dark:bg-[#2e3440]"
					>
						<OpenWithMenu path={ws.path} {vscodeSshHost} {onOpenTerminal} />
						<div class="mx-0.5 h-4 w-px shrink-0 bg-[#d8dee9] dark:bg-[#434c5e]"></div>
						<WorkspaceMoreMenu
							name={ws.name}
							canRerun={Boolean(ws.solutionMetadata)}
							rerunning={rerunSessions.has(ws.id)}
							deleting={deletingWorkspaces.has(ws.id)}
							onRerun={() => rerunBootstrap(ws)}
							onDelete={() => deleteWorkspace(ws)}
						/>
					</div>
				</div>

				<div class="px-5">
					<RequestError message={operationErrors[ws.id] ?? ''} />
					<RequestError
						message={ws.buildSession ? (operationErrors[ws.buildSession.id] ?? '') : ''}
					/>
				</div>
				{#if expanded.has(ws.id)}
					{#if ws.buildSession?.status === 'running'}
						<!-- Inline terminal view for a running bootstrap; closes when the process exits -->
						<div class="border-b border-[#d8dee9] dark:border-[#4c566a]">
							<div class="h-64 overflow-hidden">
								<TerminalTab
									sessionId={ws.buildSession.id}
									active={true}
									onExit={refreshAfterExit}
								/>
							</div>
						</div>
					{:else}
						<div class="bg-[#f0f4f8] dark:bg-[#2e3440]">
							{#if ws.buildSession?.status === 'failed'}
								<!-- Failed bootstrap run: the output is kept as a log until dismissed -->
								<div
									class="flex items-center gap-2 border-b border-[#bf616a]/20 bg-[#bf616a]/10 px-5 py-2 text-[#bf616a]"
								>
									<TriangleAlert size={14} />
									<span class="flex-1 text-sm font-medium">Bootstrap failed</span>
									{#if ws.buildSession.hasLog}
										<button
											onclick={() => openBootstrapLog(ws)}
											class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors hover:bg-[#bf616a]/20"
											type="button"
										>
											<FileText size={12} />
											View log
										</button>
									{/if}
									<button
										onclick={() => dismissBootstrapRun(ws.buildSession!.id)}
										class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors hover:bg-[#bf616a]/20"
										type="button"
										title="Dismiss and delete the log"
									>
										<X size={12} />
										Dismiss
									</button>
								</div>
							{/if}
							{#if rerunSessions.has(ws.id)}
								{@const rerunSession = rerunSessions.get(ws.id)!}
								<!-- Rerun progress row -->
								<div
									class="flex items-center gap-2 border-b border-[#b48ead]/20 bg-[#b48ead]/10 px-5 py-1.5"
								>
									<button
										onclick={() => toggleRerunTerminal(ws.id)}
										type="button"
										class="shrink-0 rounded p-0.5 text-[#b48ead]/70 transition-colors hover:bg-[#b48ead]/20 hover:text-[#b48ead]"
										aria-label={rerunSession.visible ? 'Hide output' : 'Show output'}
									>
										{#if rerunSession.visible}
											<ChevronDown size={13} />
										{:else}
											<ChevronRight size={13} />
										{/if}
									</button>
									<Loader2 size={12} class="animate-spin text-[#b48ead]" />
									<span class="text-xs font-medium text-[#b48ead]">Rerunning bootstrap…</span>
									<button
										onclick={() => dismissRerun(ws.id)}
										disabled={pendingOperations.has(ws.id)}
										class="ml-auto rounded p-0.5 text-[#b48ead]/60 transition-colors hover:bg-[#b48ead]/20 hover:text-[#b48ead]"
										type="button"
										aria-label="Cancel">✕</button
									>
								</div>
								<!-- Terminal: always mounted to keep WebSocket alive; shown/hidden via display -->
								<div
									class="overflow-hidden border-b border-[#b48ead]/20"
									style:display={rerunSession.visible ? 'block' : 'none'}
									style:height={rerunSession.visible ? '16rem' : '0'}
								>
									<TerminalTab
										sessionId={rerunSession.sessionId}
										command="devbootstrap --rerun -d {ws.path}"
										cwd={ws.path}
										kind="bootstrap"
										active={rerunSession.visible}
										onExit={() => onRerunExit(ws.id)}
									/>
								</div>
							{/if}
							{#each ws.repos as repo (repo.path)}
								{@const matchedContainer = findContainerForRepo(repo.path)}
								{@const repoExpandable = repo.buildSession?.status === 'running'}
								<div
									class="flex min-h-[2.5rem] flex-wrap items-center gap-y-2 border-b border-[#d8dee9]/60 py-1.5 pr-5 pl-8 last:border-b-0 dark:border-[#4c566a]/60"
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
															{#if branchPickerBranches.length === 0 && branchPickerTags.length === 0 && !operationErrors[repo.path]}
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
													running={matchedContainer.state === 'running'}
													variant="row"
													containerName={matchedContainer.name}
													projectName={matchedContainer.projectName}
													workspacePath={matchedContainer.localWorkspacePath}
													allPorts={matchedContainer.ports}
													containerId={matchedContainer.id}
													{serviceProxyEnabled}
												/>
											{/each}
										</div>
									{/if}

									<!-- Action column: devcontainer actions, then Open with pinned to the right edge -->
									<div class="ml-auto flex shrink-0 items-center justify-end gap-2">
										{#if repo.composeFiles?.length}
											<!-- Compose sandbox controls; no devcontainer is required -->
											<button
												onclick={() => toggleSandbox(repo.path)}
												aria-expanded={sandboxRepos.has(repo.path)}
												class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium whitespace-nowrap text-[#5e81ac] transition-colors hover:bg-[#e5e9f0] aria-expanded:bg-[#e5e9f0] dark:text-[#88c0d0] dark:hover:bg-[#3b4252] dark:aria-expanded:bg-[#3b4252]"
												type="button"
												title="Build and run the Compose sandbox of this repository"
											>
												{#if repo.composeRun?.status === 'running'}
													<Loader size={12} class="animate-spin" />
												{:else if repo.composeRun?.status === 'failed'}
													<TriangleAlert size={12} class="text-[#bf616a]" />
												{:else}
													<Boxes size={12} />
												{/if}
												Sandbox
											</button>
										{/if}
										{#if repo.hasDevcontainer}
											<div class="flex items-center gap-1">
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
													{#if repo.buildSession?.status === 'running'}
														<button
															onclick={() => dismissBuild(repo.buildSession!.id)}
															class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium whitespace-nowrap text-[#bf616a] transition-colors hover:bg-[#e5e9f0] dark:hover:bg-[#3b4252]"
															type="button"
															title="Cancel the build; no log is kept"
														>
															<X size={12} />
															Cancel
														</button>
													{/if}
												{:else if repo.buildSession?.status === 'failed'}
													{#if repo.buildSession.hasLog}
														<button
															onclick={() => openBuildLog(repo)}
															class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium whitespace-nowrap text-[#81a1c1] transition-colors hover:bg-[#e5e9f0] dark:hover:bg-[#3b4252]"
															type="button"
															title="View the build log"
														>
															<FileText size={12} />
															Log
														</button>
													{/if}
													<button
														onclick={() =>
															buildAndStart(repo.path, repo.name, getEffectiveConfig(repo))}
														class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium whitespace-nowrap text-[#ebcb8b] transition-colors hover:bg-[#e5e9f0] dark:hover:bg-[#3b4252]"
														type="button"
														title="Retry build"
													>
														<RotateCcw size={12} />
														Retry
													</button>
													<button
														onclick={() => dismissBuild(repo.buildSession!.id)}
														class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium whitespace-nowrap text-[#bf616a] transition-colors hover:bg-[#e5e9f0] dark:hover:bg-[#3b4252]"
														type="button"
														title="Dismiss failed build"
													>
														<X size={12} />
														Dismiss
													</button>
												{:else}
													{#if repo.devcontainerConfigs?.length > 1}
														{@const selectedCfg = getEffectiveConfig(repo)!}
														<div class="relative">
															<button
																onclick={(e) => {
																	e.stopPropagation();
																	configPickerRepo =
																		configPickerRepo === repo.path ? null : repo.path;
																}}
																class="flex items-center gap-0.5 rounded-lg px-1.5 py-1 text-xs font-medium whitespace-nowrap text-[#81a1c1] transition-colors hover:bg-[#e5e9f0] dark:hover:bg-[#3b4252]"
																type="button"
																title="Select devcontainer config"
															>
																<span class="max-w-[72px] truncate"
																	>{getConfigDisplayName(selectedCfg)}</span
																>
																<ChevronDown size={10} />
															</button>
															{#if configPickerRepo === repo.path}
																<div
																	class="absolute top-full right-0 z-20 mt-1 w-44 overflow-hidden rounded-lg border border-[#d8dee9] bg-white shadow-lg dark:border-[#4c566a] dark:bg-[#3b4252]"
																>
																	<div
																		class="border-b border-[#d8dee9] px-3 py-1.5 text-[10px] font-semibold tracking-wide text-[#4c566a] uppercase dark:border-[#4c566a] dark:text-[#d8dee9]/50"
																	>
																		Config
																	</div>
																	{#each repo.devcontainerConfigs as cfg (cfg)}
																		<button
																			onclick={() => selectConfig(repo.path, cfg)}
																			class="w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-[#e5e9f0] dark:hover:bg-[#434c5e] {cfg ===
																			selectedCfg
																				? 'font-bold text-[#88c0d0]'
																				: 'text-[#2e3440] dark:text-[#d8dee9]'}"
																			type="button"
																		>
																			{getConfigDisplayName(cfg)}
																			{#if cfg === selectedCfg}
																				<span class="ml-1 text-[#a3be8c]">✓</span>
																			{/if}
																		</button>
																	{/each}
																</div>
															{/if}
														</div>
													{/if}
													<button
														onclick={() =>
															buildAndStart(repo.path, repo.name, getEffectiveConfig(repo))}
														class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium whitespace-nowrap text-[#81a1c1] transition-colors hover:bg-[#e5e9f0] dark:hover:bg-[#3b4252]"
														type="button"
													>
														<Play size={12} />
														Build &amp; Start
													</button>
												{/if}
											</div>
										{/if}
										<div
											class="flex items-center rounded-xl border border-[#d8dee9] bg-[#eceff4] p-1 shadow-sm dark:border-[#434c5e] dark:bg-[#2e3440]"
										>
											<OpenWithMenu path={repo.path} {vscodeSshHost} {onOpenTerminal} />
										</div>
									</div>
								</div>
								<div class="px-8">
									<RequestError message={operationErrors[repo.path] ?? ''} />
									<RequestError
										message={repo.buildSession ? (operationErrors[repo.buildSession.id] ?? '') : ''}
									/>
								</div>
								{#if repoExpandable && repo.buildSession && expandedRepos.has(repo.path)}
									<!-- Build output while the build runs; closes when the process exits -->
									<div class="border-b border-[#d8dee9]/60 dark:border-[#4c566a]/60">
										<div class="h-64 overflow-hidden">
											<TerminalTab
												sessionId={repo.buildSession.id}
												active={true}
												onExit={refreshAfterExit}
											/>
										</div>
									</div>
								{/if}
								{#if repo.composeFiles?.length && sandboxRepos.has(repo.path)}
									<ComposeSandboxPanel
										{repo}
										onRefresh={onRefreshWorkspaces}
										{onRefreshContainers}
										{onOpenTerminal}
										onOpenLog={openLog}
									/>
								{/if}
							{/each}
						</div>
					{/if}
				{/if}
			{/each}
		</div>
	{/if}

	{#if logViewer}
		<LogViewer logId={logViewer.id} title={logViewer.title} onClose={() => (logViewer = null)} />
	{/if}
</section>
