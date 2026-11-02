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
		EyeOff,
		LogOut,
		Plus,
		Loader2,
		X,
		RefreshCw
	} from 'lucide-svelte';
	import { untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import type {
		ContainerData,
		LocalWorkspaceData,
		PolarisInstance,
		PolarisType,
		TerminalSession
	} from '$lib/types';
	import DevcontainerCard from '$lib/components/DevcontainerCard.svelte';
	import DevcontainerRow from '$lib/components/DevcontainerRow.svelte';
	import SandboxRow from '$lib/components/SandboxRow.svelte';
	import ComposeGroupRow from '$lib/components/ComposeGroupRow.svelte';
	import LocalWorkspaces from '$lib/components/LocalWorkspaces.svelte';
	import PolarisStack from '$lib/components/PolarisStack.svelte';
	import BootstrapModal from '$lib/components/BootstrapModal.svelte';
	import TerminalManager from '$lib/components/TerminalManager.svelte';

	interface AvailableSource {
		type: string;
		tags: string[];
		allServices: string[];
		defaultServices: string[];
	}

	interface Props {
		data: {
			containers: ContainerData[];

			workspaces: LocalWorkspaceData[];
			workspaceRoot: string;
			vscodeSshHost: string;
			polarisInstances: PolarisInstance[];
			availableSources: AvailableSource[];
			nginxDomain: string | null;
		};
	}

	let { data }: Props = $props();

	// untrack prevents svelte from treating data.containers as a reactive dep;
	// polling handles subsequent updates
	let containers = $state<ContainerData[]>(untrack(() => data.containers));
	let workspaces = $state<LocalWorkspaceData[]>(untrack(() => data.workspaces));
	let polarisInstances = $state<PolarisInstance[]>(untrack(() => data.polarisInstances));
	let availableSources = $state<AvailableSource[]>(untrack(() => data.availableSources));
	const nginxDomain = untrack(() => data.nginxDomain);
	let updatingNginx = $state(false);
	let nginxResult = $state<string | null>(null);
	let dark = $state(true);

	// New-instance dialog state
	let showNewDialog = $state(false);
	let newInstanceType = $state<PolarisType>('polaris-ice');
	let newInstanceTag = $state<string>('');
	let newInstanceServices = $state<string[]>([]);
	let creatingInstance = $state(false);
	let createError = $state<string | null>(null);

	// Available tags/services for currently-selected type
	const selectedSource = $derived(availableSources.find((s) => s.type === newInstanceType));
	const tagsForSelectedType = $derived(selectedSource?.tags ?? []);
	const allServicesForType = $derived(selectedSource?.allServices ?? []);
	const defaultServicesForType = $derived(selectedSource?.defaultServices ?? []);

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
			await refreshTerminalSessions();
		}, 5000);
		return () => clearInterval(interval);
	});

	// Pick up terminal sessions that are already running server-side (e.g. opened from another
	// browser, or still running from before a reload) so the drawer can reattach to them.
	$effect(() => {
		refreshTerminalSessions();
	});

	async function refreshContainers() {
		const [containersRes, stacksRes] = await Promise.all([
			fetch('/api/containers'),
			fetch('/api/stacks')
		]);
		if (containersRes.ok) containers = await containersRes.json();
		if (stacksRes.ok) {
			const { instances, availableSources: sources } = await stacksRes.json();
			polarisInstances = instances;
			availableSources = sources;
			// Keep tag selection valid after poll
			if (!tagsForSelectedType.includes(newInstanceTag)) {
				newInstanceTag = tagsForSelectedType[0] ?? '';
			}
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

	// IDs of containers already shown in the Polaris section
	const polarisContainerIds = $derived(
		new Set(polarisInstances.flatMap((inst) => inst.containers.map((c) => c.id)))
	);

	const devcontainers = $derived(sortContainers(containers.filter((c) => c.isDevcontainer)));
	const sandboxes = $derived(
		sortContainers(containers.filter((c) => !c.isDevcontainer && !polarisContainerIds.has(c.id)))
	);
	const standaloneSandboxes = $derived(sandboxes.filter((c) => !c.composeProject));
	const composeGroups = $derived.by(() => {
		const map = new SvelteMap<string, ContainerData[]>();
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

	let terminalOpen = $state(false);
	let terminalSessions = $state<TerminalSession[]>([]);
	let activeTerminalId = $state<string | null>(null);

	function openTerminalWith(id: string) {
		terminalOpen = true;
		activeTerminalId = id;
	}

	function addTerminalSession(session: TerminalSession) {
		terminalSessions = [...terminalSessions, session];
	}

	function removeTerminalSessionLocally(id: string) {
		terminalSessions = terminalSessions.filter((s) => s.id !== id);
		confirmedTerminalSessionIds.delete(id);
		if (activeTerminalId === id) {
			activeTerminalId = terminalSessions[terminalSessions.length - 1]?.id ?? null;
		}
		if (terminalSessions.length === 0) terminalOpen = false;
	}

	async function closeTerminalSession(id: string) {
		try {
			await fetch('/api/terminal/sessions', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id })
			});
		} finally {
			removeTerminalSessionLocally(id);
		}
	}

	// Tracks which local tabs have been confirmed to exist server-side at least once, so a
	// freshly-opened tab isn't dropped by reconciliation before its WebSocket has connected.
	const confirmedTerminalSessionIds = new SvelteSet<string>();

	async function refreshTerminalSessions() {
		const res = await fetch('/api/terminal/sessions');
		if (!res.ok) return;
		const serverSessions: TerminalSession[] = await res.json();
		const serverIds = new SvelteSet(serverSessions.map((s) => s.id));
		const localIds = new SvelteSet(terminalSessions.map((s) => s.id));

		for (const id of serverIds) confirmedTerminalSessionIds.add(id);

		// Drop local tabs whose confirmed session no longer exists server-side (killed/exited
		// elsewhere); leave not-yet-confirmed tabs alone so brand-new tabs aren't removed early.
		const kept = terminalSessions.filter(
			(s) => serverIds.has(s.id) || !confirmedTerminalSessionIds.has(s.id)
		);
		// Add tabs for sessions that exist server-side but aren't open locally yet
		const added = serverSessions.filter((s) => !localIds.has(s.id));

		if (kept.length !== terminalSessions.length || added.length > 0) {
			terminalSessions = [...kept, ...added];
			if (activeTerminalId && !terminalSessions.some((s) => s.id === activeTerminalId)) {
				activeTerminalId = terminalSessions[terminalSessions.length - 1]?.id ?? null;
			}
			if (terminalSessions.length === 0) terminalOpen = false;
		}
	}

	function handleRunBackground() {
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

	async function handleCreateInstance() {
		creatingInstance = true;
		createError = null;
		try {
			const res = await fetch('/api/stacks', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					type: newInstanceType,
					tag: newInstanceTag || undefined,
					services: newInstanceServices.length > 0 ? newInstanceServices : undefined
				})
			});
			if (!res.ok) {
				const body = await res.text();
				throw new Error(body);
			}
			showNewDialog = false;
			await refreshContainers();
		} catch (err: unknown) {
			createError = err instanceof Error ? err.message : String(err);
		} finally {
			creatingInstance = false;
		}
	}

	async function handleUpdateNginx() {
		updatingNginx = true;
		nginxResult = null;
		try {
			const res = await fetch('/api/nginx', { method: 'POST' });
			const body = await res.json();
			if (!res.ok) throw new Error(body?.message ?? res.statusText);
			nginxResult = `OK — ${body.entries?.length ?? 0} container(s) mapped to ${nginxDomain}`;
		} catch (err: unknown) {
			nginxResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			updatingNginx = false;
		}
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

					<form method="POST" action="/logout">
						<button
							type="submit"
							class="rounded-full border border-[#d8dee9] bg-[#eceff4] p-2 text-[#4c566a] transition-opacity hover:opacity-80 dark:border-[#434c5e] dark:bg-[#2e3440] dark:text-[#d8dee9]"
							title="Sign out"
							aria-label="Sign out"
						>
							<LogOut size={20} />
						</button>
					</form>
				</div>
			</div>
		</header>

		<main class="mx-auto mt-8 max-w-7xl space-y-12 px-6">
			<!-- ── Section: Polaris Instances ───────────────────────────────────── -->
			{#if polarisInstances.length > 0 || availableSources.length > 0}
				<section>
					<div
						class="mb-6 flex items-center justify-between border-b border-[#d8dee9] pb-2 dark:border-[#4c566a]"
					>
						<div class="flex items-center gap-2">
							<Server size={20} class="text-[#88c0d0]" />
							<h2 class="text-xl font-extrabold text-[#2e3440] dark:text-[#eceff4]">
								Polaris Instances
							</h2>
							<span class="ml-1 text-sm font-medium text-[#4c566a] dark:text-[#d8dee9]/60">
								({polarisInstances.length} instance{polarisInstances.length !== 1 ? 's' : ''})
							</span>
						</div>

						{#if availableSources.length > 0}
							<button
								onclick={() => {
									showNewDialog = true;
									createError = null;
									// Initialize type/tag/services to first available source
									const first = availableSources[0];
									if (first) {
										newInstanceType = first.type as PolarisType;
										newInstanceTag = first.tags[0] ?? '';
										newInstanceServices = [...first.defaultServices];
									}
								}}
								class="flex items-center gap-1.5 rounded-lg border border-[#88c0d0]/30 bg-[#88c0d0]/10 px-3 py-1.5 text-sm
							       font-semibold text-[#88c0d0] transition-colors hover:bg-[#88c0d0]/20"
								title="Create a new Polaris sandbox instance with an automatically allocated subnet"
							>
								<Plus size={16} />
								New Instance
							</button>
						{/if}
						{#if nginxDomain}
							<button
								onclick={handleUpdateNginx}
								disabled={updatingNginx}
								class="flex items-center gap-1.5 rounded-lg border border-[#a3be8c]/30 bg-[#a3be8c]/10 px-3 py-1.5 text-sm
							       font-semibold text-[#a3be8c] transition-colors hover:bg-[#a3be8c]/20 disabled:cursor-not-allowed disabled:opacity-50"
								title="Regenerate nginx reverse-proxy config for all running Polaris NoVNC ports"
							>
								{#if updatingNginx}
									<Loader2 size={16} class="animate-spin" />
								{:else}
									<RefreshCw size={16} />
								{/if}
								Update Nginx
							</button>
						{/if}
					</div>

					{#if nginxResult}
						<div
							class="mb-4 rounded-lg border px-3 py-2 text-sm
						{nginxResult.startsWith('Error')
								? 'border-[#bf616a]/30 bg-[#bf616a]/10 text-[#bf616a]'
								: 'border-[#a3be8c]/30 bg-[#a3be8c]/10 text-[#a3be8c]'}"
						>
							{nginxResult}
						</div>
					{/if}

					{#if polarisInstances.length === 0}
						<div
							class="rounded-xl border border-[#d8dee9] bg-white p-8 text-center text-[#4c566a] italic dark:border-[#4c566a] dark:bg-[#3b4252] dark:text-[#d8dee9]/60"
						>
							No Polaris containers found. Start a stack with
							<code class="rounded bg-[#eceff4] px-1 py-0.5 font-mono text-xs dark:bg-[#434c5e]"
								>docker compose up -d</code
							>
							in the polaris project directory, or create a new instance here.
						</div>
					{:else}
						<div class="space-y-6">
							{#each polarisInstances as instance (instance.id)}
								<PolarisStack
									{instance}
									{vscodeSshHost}
									onRefresh={refreshContainers}
									onOpenTerminal={handleOpenTerminal}
									nginxDomain={nginxDomain ?? undefined}
								/>
							{/each}
						</div>
					{/if}
				</section>
			{/if}

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

	<!-- ── New Instance Dialog ──────────────────────────────────────────────────── -->
	{#if showNewDialog}
		<!-- Backdrop -->
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
			onclick={() => {
				if (!creatingInstance) showNewDialog = false;
			}}
			onkeydown={(e) => {
				if (e.key === 'Escape' && !creatingInstance) showNewDialog = false;
			}}
			role="dialog"
			aria-modal="true"
			aria-label="Create new Polaris instance"
			tabindex="-1"
		>
			<!-- Modal -->
			<div
				class="w-full max-w-md space-y-5 rounded-2xl border border-[#d8dee9] bg-white p-6 shadow-2xl dark:border-[#4c566a] dark:bg-[#3b4252]"
				onclick={(e) => e.stopPropagation()}
				role="presentation"
			>
				<div class="flex items-center justify-between">
					<div>
						<h3 class="text-lg font-extrabold text-[#2e3440] dark:text-[#eceff4]">
							New Polaris Instance
						</h3>
						<p class="mt-0.5 text-xs text-[#4c566a] dark:text-[#d8dee9]/60">
							Allocates a new subnet and generates a modified docker-compose
						</p>
					</div>
					<button
						onclick={() => (showNewDialog = false)}
						disabled={creatingInstance}
						class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#eceff4] disabled:opacity-40 dark:text-[#d8dee9]/70 dark:hover:bg-[#434c5e]"
					>
						<X size={18} />
					</button>
				</div>

				<div class="space-y-3">
					<p class="block text-sm font-semibold text-[#2e3440] dark:text-[#d8dee9]">
						Instance type
					</p>
					<div class="flex gap-3" role="group" aria-label="Select instance type">
						{#each availableSources as src (src.type)}
							<button
								onclick={() => {
									newInstanceType = src.type as PolarisType;
									newInstanceTag = src.tags[0] ?? '';
									newInstanceServices = [...src.defaultServices];
								}}
								class="flex-1 rounded-xl border-2 px-4 py-2.5 text-sm font-semibold transition-colors
							       {newInstanceType === src.type
									? 'border-[#88c0d0] bg-[#88c0d0]/10 text-[#5e81ac] dark:text-[#88c0d0]'
									: 'border-[#d8dee9] text-[#4c566a] hover:border-[#88c0d0]/50 dark:border-[#4c566a] dark:text-[#d8dee9]/70'}"
								aria-pressed={newInstanceType === src.type}
							>
								{src.type}
							</button>
						{/each}
					</div>
				</div>

				{#if tagsForSelectedType.length > 0}
					<div class="space-y-2">
						<label
							for="tag-select"
							class="block text-sm font-semibold text-[#2e3440] dark:text-[#d8dee9]"
						>
							Image tag / version
						</label>
						<select
							id="tag-select"
							bind:value={newInstanceTag}
							disabled={creatingInstance}
							class="w-full rounded-xl border border-[#d8dee9] bg-white px-3 py-2 text-sm
					       text-[#2e3440] focus:border-[#88c0d0] focus:outline-none disabled:opacity-50
					       dark:border-[#4c566a] dark:bg-[#2e3440] dark:text-[#d8dee9]"
						>
							{#each tagsForSelectedType as tag (tag)}
								<option value={tag}>{tag}</option>
							{/each}
						</select>
						<p class="text-xs text-[#4c566a] dark:text-[#d8dee9]/60">
							Tags detected from locally-pulled Docker images. Pull a newer image first if the
							version is not listed.
						</p>
					</div>
				{:else}
					<div
						class="rounded-lg border border-[#ebcb8b]/30 bg-[#ebcb8b]/10 p-3 text-xs text-[#4c566a] dark:text-[#d8dee9]/70"
					>
						No local image tags found for <strong>{newInstanceType}</strong>. The compose file will
						use <code class="font-mono">$&#123;TAG:-latest&#125;</code> — make sure the images are pulled.
					</div>
				{/if}

				{#if allServicesForType.length > 0}
					<div class="space-y-2">
						<div class="flex items-center justify-between">
							<p class="text-sm font-semibold text-[#2e3440] dark:text-[#d8dee9]">
								Services to start
							</p>
							<div class="flex gap-2 text-xs">
								<button
									onclick={() => (newInstanceServices = [...allServicesForType])}
									disabled={creatingInstance}
									class="text-[#88c0d0] hover:underline disabled:opacity-50">All</button
								>
								<button
									onclick={() => (newInstanceServices = [...defaultServicesForType])}
									disabled={creatingInstance}
									class="text-[#88c0d0] hover:underline disabled:opacity-50">Default</button
								>
								<button
									onclick={() => (newInstanceServices = [])}
									disabled={creatingInstance}
									class="text-[#4c566a] hover:underline disabled:opacity-50 dark:text-[#d8dee9]/60"
									>None</button
								>
							</div>
						</div>
						<div class="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto pr-1">
							{#each allServicesForType as svc (svc)}
								{@const checked = newInstanceServices.includes(svc)}
								{@const isDefault = defaultServicesForType.includes(svc)}
								<label
									class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm transition-colors hover:bg-[#eceff4] dark:hover:bg-[#434c5e]"
								>
									<input
										type="checkbox"
										{checked}
										disabled={creatingInstance}
										onchange={() => {
											if (checked) {
												newInstanceServices = newInstanceServices.filter((s) => s !== svc);
											} else {
												newInstanceServices = [...newInstanceServices, svc];
											}
										}}
										class="accent-[#88c0d0]"
									/>
									<span class="text-[#2e3440] dark:text-[#d8dee9]">{svc}</span>
									{#if isDefault}
										<span class="text-[0.6rem] font-semibold text-[#88c0d0] uppercase">default</span
										>
									{/if}
								</label>
							{/each}
						</div>
						<p class="text-xs text-[#4c566a] dark:text-[#d8dee9]/60">
							Support services (mysql, tatoo) are always started via <code class="font-mono"
								>depends_on</code
							>.
						</p>
					</div>
				{/if}

				<div
					class="space-y-1 rounded-lg bg-[#eceff4] p-3 text-xs text-[#4c566a] dark:bg-[#2e3440] dark:text-[#d8dee9]/70"
				>
					<p>The dashboard will:</p>
					<ul class="ml-1 list-inside list-disc space-y-0.5">
						<li>Allocate the next free <code class="font-mono">192.168.X.0/24</code> subnet</li>
						<li>
							Generate a new <code class="font-mono">docker-compose.yml</code> with updated IPs
						</li>
						<li>Rewrite hosts files for all modes (training / playback / testing / operational)</li>
						<li>Fix <code class="font-mono">orion-environmental.json</code> with new subnet IPs</li>
						<li>
							Remove the conflicting <code class="font-mono">orion-mysql</code> alias from hosts
						</li>
						<li>
							Start selected services with <code class="font-mono">docker compose up -d</code>
						</li>
					</ul>
				</div>

				{#if createError}
					<div
						class="rounded-lg border border-[#bf616a]/30 bg-[#bf616a]/10 p-3 text-sm text-[#bf616a]"
					>
						{createError}
					</div>
				{/if}

				<div class="flex gap-3 pt-1">
					<button
						onclick={() => (showNewDialog = false)}
						disabled={creatingInstance}
						class="flex-1 rounded-xl border border-[#d8dee9] px-4 py-2.5 text-sm font-semibold
					       text-[#4c566a] transition-colors hover:bg-[#eceff4] disabled:opacity-50
					       dark:border-[#4c566a] dark:text-[#d8dee9]/70 dark:hover:bg-[#434c5e]"
					>
						Cancel
					</button>
					<button
						onclick={handleCreateInstance}
						disabled={creatingInstance}
						class="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#88c0d0]
					       px-4 py-2.5 text-sm font-semibold text-[#2e3440]
					       transition-colors hover:bg-[#81a1c1] disabled:cursor-not-allowed disabled:opacity-60"
					>
						{#if creatingInstance}
							<Loader2 size={15} class="animate-spin" />
							Creating…
						{:else}
							<Plus size={15} />
							Create & Start
						{/if}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Terminal Drawer -->
	<TerminalManager
		open={terminalOpen}
		sessions={terminalSessions}
		activeId={activeTerminalId}
		workspaceRoot={WORKSPACE_ROOT}
		onToggle={() => (terminalOpen = !terminalOpen)}
		onAddSession={addTerminalSession}
		onCloseSession={closeTerminalSession}
		onSetActive={(id) => (activeTerminalId = id)}
	/>
</div>
