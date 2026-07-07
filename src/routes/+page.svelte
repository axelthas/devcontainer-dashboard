<script lang="ts">
	import {
		Sun,
		Moon,
		Layers,
		Box,
		Cpu,
		Power,
		Server,
		LayoutGrid,
		List,
		Eye,
		EyeOff
	} from 'lucide-svelte';
	import { untrack } from 'svelte';
	import type { ContainerData, LocalWorkspaceData } from '$lib/types';
	import DevcontainerCard from '$lib/components/DevcontainerCard.svelte';
	import DevcontainerRow from '$lib/components/DevcontainerRow.svelte';
	import SandboxRow from '$lib/components/SandboxRow.svelte';
	import ComposeGroupRow from '$lib/components/ComposeGroupRow.svelte';
	import LocalWorkspaces from '$lib/components/LocalWorkspaces.svelte';
	import BootstrapModal from '$lib/components/BootstrapModal.svelte';
	import TerminalManager from '$lib/components/TerminalManager.svelte';

	interface Props {
		data: {
			containers: ContainerData[];
			hostname: string;
			workspaces: LocalWorkspaceData[];
			workspaceRoot: string;
			vscodeSshHost: string;
		};
	}

	let { data }: Props = $props();

	// untrack prevents svelte from treating data.containers as a reactive dep;
	// polling handles subsequent updates
	let containers = $state<ContainerData[]>(untrack(() => data.containers));
	let workspaces = $state<LocalWorkspaceData[]>(untrack(() => data.workspaces));
	let dark = $state(true);

	const THEME_KEY = 'devcontainer-dashboard-theme';

	$effect(() => {
		const stored = localStorage.getItem(THEME_KEY);
		if (stored !== null) dark = stored === 'dark';
	});

	$effect(() => {
		localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
	});

	const SSH_HOST_KEY = 'devcontainer-dashboard-vscode-ssh-host';
	let vscodeSshHost = $state(data.vscodeSshHost);

	$effect(() => {
		const stored = localStorage.getItem(SSH_HOST_KEY);
		if (stored !== null) {
			vscodeSshHost = stored;
		} else if (!vscodeSshHost) {
			// Auto-detect from URL hostname when no explicit value is configured
			const urlHostname = window.location.hostname;
			const isLoopback =
				urlHostname === 'localhost' ||
				urlHostname === '127.0.0.1' ||
				urlHostname === '[::1]' ||
				urlHostname === '::1';
			if (!isLoopback) vscodeSshHost = urlHostname;
		}
	});

	$effect(() => {
		localStorage.setItem(SSH_HOST_KEY, vscodeSshHost);
	});

	// View toggle
	const VIEW_KEY = 'devcontainer-dashboard-view';
	let devcontainerView = $state<'grid' | 'list'>('grid');

	$effect(() => {
		const stored = localStorage.getItem(VIEW_KEY);
		if (stored === 'grid' || stored === 'list') devcontainerView = stored;
	});

	$effect(() => {
		localStorage.setItem(VIEW_KEY, devcontainerView);
	});

	// Show/hide stopped devcontainers
	const SHOW_STOPPED_KEY = 'devcontainer-dashboard-show-stopped';
	let showStopped = $state(false);

	$effect(() => {
		const stored = localStorage.getItem(SHOW_STOPPED_KEY);
		if (stored !== null) showStopped = stored === 'true';
	});

	$effect(() => {
		localStorage.setItem(SHOW_STOPPED_KEY, String(showStopped));
	});

	// Poll every 5 seconds
	$effect(() => {
		const interval = setInterval(async () => {
			await refreshContainers();
		}, 5000);
		return () => clearInterval(interval);
	});

	async function refreshContainers() {
		const res = await fetch('/api/containers');
		if (res.ok) {
			containers = await res.json();
		}
	}

	async function refreshWorkspaces() {
		const res = await fetch('/api/workspaces');
		if (res.ok) {
			workspaces = await res.json();
		}
	}

	// Auto-poll workspaces every 3 s while any bootstrap run or devcontainer build is active
	const hasActiveBuilds = $derived(
		workspaces.some(
			(w) =>
				w.buildSession?.status === 'running' ||
				w.repos.some((r) => r.buildSession?.status === 'running')
		)
	);

	$effect(() => {
		if (!hasActiveBuilds) return;
		const interval = setInterval(refreshWorkspaces, 3000);
		return () => clearInterval(interval);
	});

	function sortContainers(list: ContainerData[]) {
		return [...list].sort((a, b) => {
			const aRunning = a.state === 'running' ? 0 : 1;
			const bRunning = b.state === 'running' ? 0 : 1;
			return aRunning - bRunning;
		});
	}

	const devcontainers = $derived(sortContainers(containers.filter((c) => c.isDevcontainer)));
	const sandboxes = $derived(sortContainers(containers.filter((c) => !c.isDevcontainer)));
	const standaloneSandboxes = $derived(sandboxes.filter((c) => !c.composeProject));
	const composeGroups = $derived.by(() => {
		const map = new Map<string, ContainerData[]>();
		for (const c of sandboxes) {
			if (!c.composeProject) continue;
			const list = map.get(c.composeProject);
			if (list) list.push(c);
			else map.set(c.composeProject, [c]);
		}
		return [...map.entries()]
			.map(([name, ctrs]) => ({ projectName: name, containers: ctrs }))
			.sort((a, b) => {
				const aRunning = a.containers.filter((c) => c.state === 'running').length;
				const bRunning = b.containers.filter((c) => c.state === 'running').length;
				return bRunning - aRunning;
			});
	});
	const runningCount = $derived(containers.filter((c) => c.state === 'running').length);
	const stoppedCount = $derived(containers.filter((c) => c.state !== 'running').length);
	const stoppedDevcontainerCount = $derived(
		devcontainers.filter((c) => c.state !== 'running').length
	);
	const visibleDevcontainers = $derived(
		showStopped ? devcontainers : devcontainers.filter((c) => c.state === 'running')
	);

	// Bootstrap modal
	let bootstrapModalOpen = $state(false);

	// Terminal manager state
	const WORKSPACE_ROOT = data.workspaceRoot;

	interface TerminalSessionState {
		id: string;
		name: string;
		command?: string;
		cwd?: string;
	}

	let terminalOpen = $state(false);
	let terminalSessions = $state<TerminalSessionState[]>([]);
	let activeTerminalId = $state<string | null>(null);

	function openTerminalWith(id: string) {
		terminalOpen = true;
		activeTerminalId = id;
	}

	function addTerminalSession(session: TerminalSessionState) {
		terminalSessions = [...terminalSessions, session];
	}

	function removeTerminalSession(id: string) {
		terminalSessions = terminalSessions.filter((s) => s.id !== id);
		if (activeTerminalId === id) {
			activeTerminalId = terminalSessions[terminalSessions.length - 1]?.id ?? null;
		}
		if (terminalSessions.length === 0) terminalOpen = false;
	}

	function handleRunBackground(_id: string, _workspacePath: string, _name: string) {
		// Workspace row is tracked server-side; refresh so it appears immediately
		refreshWorkspaces();
	}

	function handleOpenTerminal(id: string, command: string, name: string, cwd: string) {
		addTerminalSession({ id, name, command, cwd });
		openTerminalWith(id);
	}

	function scrollToContainer(containerId: string) {
		const el = document.querySelector(`[data-container-id="${containerId}"]`);
		if (!el) return;
		el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		el.classList.add('highlight-flash');
		setTimeout(() => el.classList.remove('highlight-flash'), 1500);
	}
</script>

<div class={dark ? 'dark' : ''}>
	<div
		class="min-h-screen bg-[#eceff4] pb-40 font-sans text-[#2e3440] transition-colors duration-300 dark:bg-[#2e3440] dark:text-[#d8dee9]"
	>
		<!-- Header -->
		<header
			class="sticky top-0 z-10 border-b border-[#d8dee9] bg-[#e5e9f0] transition-colors duration-300 dark:border-[#434c5e] dark:bg-[#3b4252]"
		>
			<div
				class="mx-auto flex max-w-7xl flex-col justify-between gap-4 px-6 py-4 md:flex-row md:items-center"
			>
				<!-- Logo & Title -->
				<div class="flex items-center gap-3">
					<div class="rounded-lg bg-[#88c0d0] p-2 shadow-md">
						<Layers size={24} class="text-[#2e3440]" />
					</div>
					<div>
						<h1 class="text-xl leading-tight font-bold text-[#2e3440] dark:text-[#eceff4]">
							Docker Workspace
						</h1>
						<p class="text-xs font-medium text-[#4c566a] dark:text-[#d8dee9]/70">
							Local Environment Manager
						</p>
					</div>
				</div>

				<div class="flex items-center gap-4">
					<!-- Quick stats -->
					<div class="flex gap-3 text-sm font-medium">
						<div
							class="flex items-center gap-1.5 rounded-full border border-[#a3be8c]/20 bg-[#a3be8c]/10 px-3 py-1.5 text-[#a3be8c]"
						>
							<Power size={16} />
							<span>{runningCount} Running</span>
						</div>
						<div
							class="flex items-center gap-1.5 rounded-full border border-[#bf616a]/20 bg-[#bf616a]/10 px-3 py-1.5 text-[#bf616a]"
						>
							<Power size={16} />
							<span>{stoppedCount} Stopped</span>
						</div>
					</div>

					<!-- SSH host for VS Code remote connections -->
					<div
						class="flex items-center gap-1.5 rounded-lg border border-[#d8dee9] bg-[#eceff4] px-3 py-1.5 dark:border-[#434c5e] dark:bg-[#2e3440]"
						title="SSH host for VS Code remote connections"
					>
						<Server size={14} class="shrink-0 text-[#4c566a] dark:text-[#d8dee9]/50" />
						<input
							type="text"
							placeholder="SSH host"
							bind:value={vscodeSshHost}
							class="w-36 border-none bg-transparent text-xs text-[#4c566a] placeholder-[#4c566a]/50 outline-none dark:text-[#d8dee9]/70 dark:placeholder-[#d8dee9]/30"
						/>
					</div>

					<!-- Theme toggle -->
					<button
						onclick={() => (dark = !dark)}
						class="rounded-full border border-[#d8dee9] bg-[#eceff4] p-2 text-[#4c566a] transition-opacity hover:opacity-80 dark:border-[#434c5e] dark:bg-[#2e3440] dark:text-[#ebcb8b]"
						title="Toggle theme"
					>
						{#if dark}
							<Sun size={20} />
						{:else}
							<Moon size={20} />
						{/if}
					</button>
				</div>
			</div>
		</header>

		<main class="mx-auto mt-8 max-w-7xl space-y-12 px-6">
			<!-- Section 1: Active Devcontainers -->
			<section>
				<div
					class="mb-6 flex items-center gap-2 border-b border-[#d8dee9] pb-2 dark:border-[#4c566a]"
				>
					<Box size={20} class="text-[#5e81ac] dark:text-[#81a1c1]" />
					<h2 class="text-xl font-extrabold text-[#2e3440] dark:text-[#eceff4]">
						Active Devcontainers
					</h2>
					<div class="ml-auto flex items-center gap-2">
						{#if stoppedDevcontainerCount > 0}
							<button
								onclick={() => (showStopped = !showStopped)}
								class="flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors {showStopped
									? 'border-[#5e81ac] bg-[#eceff4] text-[#5e81ac] dark:border-[#81a1c1] dark:bg-[#2e3440] dark:text-[#81a1c1]'
									: 'border-[#d8dee9] bg-[#eceff4] text-[#4c566a] hover:text-[#2e3440] dark:border-[#434c5e] dark:bg-[#2e3440] dark:text-[#d8dee9]/60 dark:hover:text-[#eceff4]'}"
								title={showStopped ? 'Hide stopped containers' : 'Show stopped containers'}
							>
								{#if showStopped}
									<EyeOff size={14} />
								{:else}
									<Eye size={14} />
								{/if}
								<span>{stoppedDevcontainerCount} stopped</span>
							</button>
						{/if}
						<div
							class="flex items-center gap-1 rounded-lg border border-[#d8dee9] bg-[#eceff4] p-0.5 dark:border-[#434c5e] dark:bg-[#2e3440]"
						>
							<button
								onclick={() => (devcontainerView = 'grid')}
								class="rounded-md p-1.5 transition-colors {devcontainerView === 'grid'
									? 'bg-white text-[#5e81ac] shadow-sm dark:bg-[#3b4252] dark:text-[#81a1c1]'
									: 'text-[#4c566a] hover:text-[#2e3440] dark:text-[#d8dee9]/60 dark:hover:text-[#eceff4]'}"
								title="Grid view"
							>
								<LayoutGrid size={16} />
							</button>
							<button
								onclick={() => (devcontainerView = 'list')}
								class="rounded-md p-1.5 transition-colors {devcontainerView === 'list'
									? 'bg-white text-[#5e81ac] shadow-sm dark:bg-[#3b4252] dark:text-[#81a1c1]'
									: 'text-[#4c566a] hover:text-[#2e3440] dark:text-[#d8dee9]/60 dark:hover:text-[#eceff4]'}"
								title="List view"
							>
								<List size={16} />
							</button>
						</div>
					</div>
				</div>

				{#if devcontainers.length === 0}
					<p class="text-[#4c566a] italic dark:text-[#d8dee9]/60">No devcontainers found.</p>
				{:else if devcontainerView === 'grid'}
					<div class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
						{#each visibleDevcontainers as container (container.id)}
							<DevcontainerCard
								{container}
								{vscodeSshHost}
								onRefresh={refreshContainers}
								onOpenTerminal={handleOpenTerminal}
							/>
						{/each}
					</div>
				{:else}
					<div
						class="overflow-hidden rounded-xl border border-[#d8dee9] bg-white shadow-sm dark:border-[#4c566a] dark:bg-[#3b4252]"
					>
						<div class="divide-y divide-[#d8dee9] dark:divide-[#4c566a]">
							{#each visibleDevcontainers as container (container.id)}
								<DevcontainerRow
									{container}
									{vscodeSshHost}
									onRefresh={refreshContainers}
									onOpenTerminal={handleOpenTerminal}
								/>
							{/each}
						</div>
					</div>
				{/if}
				{#if !showStopped && stoppedDevcontainerCount > 0}
					<p class="mt-3 text-center text-xs text-[#4c566a]/70 dark:text-[#d8dee9]/40">
						{stoppedDevcontainerCount}
						{stoppedDevcontainerCount === 1 ? 'stopped container' : 'stopped containers'} hidden —
						<button
							onclick={() => (showStopped = true)}
							class="underline hover:text-[#4c566a] dark:hover:text-[#d8dee9]/70">show</button
						>
					</p>
				{/if}
			</section>

			<!-- Section 2: Local Workspaces -->
			<LocalWorkspaces
				workspaceRoot={WORKSPACE_ROOT}
				{workspaces}
				{containers}
				{vscodeSshHost}
				onOpenTerminal={handleOpenTerminal}
				onRefreshWorkspaces={refreshWorkspaces}
				onBootstrap={() => (bootstrapModalOpen = true)}
				onScrollToContainer={scrollToContainer}
				onRefreshContainers={refreshContainers}
			/>

			<!-- Section 3: Docker Services -->
			<section>
				<div
					class="mb-6 flex items-center gap-2 border-b border-[#d8dee9] pb-2 dark:border-[#4c566a]"
				>
					<Cpu size={20} class="text-[#4c566a] dark:text-[#d8dee9]/70" />
					<h2 class="text-xl font-extrabold text-[#2e3440] dark:text-[#eceff4]">Docker Services</h2>
					<span class="ml-2 text-sm font-medium text-[#4c566a] dark:text-[#d8dee9]/60"
						>(Compose stacks, databases, and other containers)</span
					>
				</div>

				{#if composeGroups.length === 0 && standaloneSandboxes.length === 0}
					<div
						class="overflow-hidden rounded-xl border border-[#d8dee9] bg-white shadow-sm dark:border-[#4c566a] dark:bg-[#3b4252]"
					>
						<div class="p-8 text-center text-[#4c566a] italic dark:text-[#d8dee9]/60">
							No external services exposing ports.
						</div>
					</div>
				{:else}
					<div
						class="overflow-hidden rounded-xl border border-[#d8dee9] bg-white shadow-sm dark:border-[#4c566a] dark:bg-[#3b4252]"
					>
						<div class="divide-y divide-[#d8dee9] dark:divide-[#4c566a]">
							{#each composeGroups as group (group.projectName)}
								<ComposeGroupRow
									projectName={group.projectName}
									containers={group.containers}
									{vscodeSshHost}
									onRefresh={refreshContainers}
									onOpenTerminal={handleOpenTerminal}
								/>
							{/each}
							{#each standaloneSandboxes as container (container.id)}
								<SandboxRow
									{container}
									{vscodeSshHost}
									onRefresh={refreshContainers}
									onOpenTerminal={handleOpenTerminal}
								/>
							{/each}
						</div>
					</div>
				{/if}
			</section>
		</main>
	</div>

	<!-- Bootstrap Modal -->
	{#if bootstrapModalOpen}
		<BootstrapModal
			onClose={() => (bootstrapModalOpen = false)}
			onRunBackground={handleRunBackground}
		/>
	{/if}

	<!-- Terminal Drawer -->
	<TerminalManager
		open={terminalOpen}
		sessions={terminalSessions}
		activeId={activeTerminalId}
		workspaceRoot={WORKSPACE_ROOT}
		onToggle={() => (terminalOpen = !terminalOpen)}
		onAddSession={addTerminalSession}
		onRemoveSession={removeTerminalSession}
		onSetActive={(id) => (activeTerminalId = id)}
	/>
</div>
