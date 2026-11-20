<script lang="ts">
	import {
		Sun,
		Moon,
		Box,
		Cpu,
		Power,
		Server,
		LayoutGrid,
		List,
		Eye,
		EyeOff,
		LogOut,
		MoreHorizontal
	} from 'lucide-svelte';
	import { untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import brandIcon from '$lib/assets/favicon.svg';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import type {
		ContainerData,
		LocalWorkspaceData,
		NetworkData,
		NetworkDrawerTarget,
		TerminalSession,
		ServiceAccess,
		ServicePortPolicy
	} from '$lib/types';
	import DevcontainerCard from '$lib/components/DevcontainerCard.svelte';
	import DevcontainerRow from '$lib/components/DevcontainerRow.svelte';
	import SandboxRow from '$lib/components/SandboxRow.svelte';
	import ComposeGroupRow from '$lib/components/ComposeGroupRow.svelte';
	import LocalWorkspaces from '$lib/components/LocalWorkspaces.svelte';
	import BootstrapModal from '$lib/components/BootstrapModal.svelte';
	import TerminalManager from '$lib/components/TerminalManager.svelte';
	import RequestError from '$lib/components/RequestError.svelte';
	import NetworkDrawer from '$lib/components/NetworkDrawer.svelte';
	import BrainPanel from '$lib/components/BrainPanel.svelte';
	import { errorMessage, latestRequest, requestJson } from '$lib/requests';
	import { networkMemory } from '$lib/networkMemory.svelte';
	import { brainExecutionIdOf, brainTabId, provideBrainAccess } from '$lib/brainAccess.svelte';
	import type { ConnectRequest } from '$lib/networkRules';

	interface Props {
		data: {
			containers: ContainerData[];

			workspaces: LocalWorkspaceData[];
			workspaceRoot: string;
			vscodeSshHost: string;
			serviceProxyEnabled: boolean;
			servicePorts: ServicePortPolicy;
			serviceAccess: ServiceAccess;
		};
	}

	let { data }: Props = $props();

	// Brain grants for rows and cards; descendants read them through context.
	const brainAccess = provideBrainAccess();

	// untrack prevents svelte from treating data.containers as a reactive dep;
	// polling handles subsequent updates
	let containers = $state<ContainerData[]>(untrack(() => data.containers));
	let workspaces = $state<LocalWorkspaceData[]>(untrack(() => data.workspaces));
	let dark = $state(true);
	const phoneLayout = new MediaQuery('(max-width: 767px)', false);
	const isPhoneLayout = $derived(phoneLayout.current);
	/** Phone-only disclosure for the host controls; desktop always shows them. */
	let hostMenuOpen = $state(false);
	/** Section that the phone section bar marks as current. */
	let currentSection = $state<SectionId>('devcontainers');

	type SectionId = 'devcontainers' | 'workspaces' | 'services';
	const SECTIONS: { id: SectionId; label: string }[] = [
		{ id: 'devcontainers', label: 'Containers' },
		{ id: 'workspaces', label: 'Workspaces' },
		{ id: 'services', label: 'Services' }
	];

	// Mark the section nearest the top of the viewport for the phone section bar.
	$effect(() => {
		if (typeof IntersectionObserver === 'undefined') return;
		const observer = new IntersectionObserver(
			(entries) => {
				const visible = entries
					.filter((entry) => entry.isIntersecting)
					.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
				const id = visible[0]?.target.id as SectionId | undefined;
				if (id) currentSection = id;
			},
			{ rootMargin: '-80px 0px -55% 0px' }
		);
		for (const { id } of SECTIONS) {
			const element = document.getElementById(id);
			if (element) observer.observe(element);
		}
		return () => observer.disconnect();
	});

	const THEME_KEY = 'devcontainer-dashboard-theme';

	$effect(() => {
		const stored = localStorage.getItem(THEME_KEY);
		if (stored !== null) dark = stored === 'dark';
	});

	$effect(() => {
		localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
		document.documentElement.classList.toggle('dark', dark);
		document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
	});

	const SSH_HOST_KEY = 'devcontainer-dashboard-vscode-ssh-host';
	let vscodeSshHost = $state(untrack(() => data.vscodeSshHost));

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

	// Saved network connections live in this browser; read them after hydration.
	$effect(() => {
		networkMemory.load();
	});

	const containerReads = latestRequest();
	const workspaceReads = latestRequest();
	const terminalReads = latestRequest();
	const networkReads = latestRequest();
	let containerError = $state('');
	let workspaceError = $state('');
	let terminalError = $state('');
	let networkError = $state('');
	let networks = $state<NetworkData[]>([]);

	// Schedule after completion, not at a fixed rate that can overlap slow requests.
	$effect(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			await Promise.allSettled([
				refreshContainers(),
				refreshTerminalSessions(),
				refreshNetworks(),
				brainAccess.refresh()
			]);
			if (!stopped && workspaceError) await refreshWorkspaces().catch(() => {});
			if (!stopped) timer = setTimeout(poll, 5000);
		}
		untrack(() => void poll());
		return () => {
			stopped = true;
			clearTimeout(timer);
			containerReads.cancel();
			workspaceReads.cancel();
			terminalReads.cancel();
			networkReads.cancel();
			brainAccess.dispose();
		};
	});

	async function refreshContainers() {
		try {
			await containerReads.run(
				(signal) => requestJson<ContainerData[]>('/api/containers', { signal }),
				(value) => {
					containers = value;
					containerError = '';
				}
			);
		} catch (cause) {
			containerError = `Container status may be outdated. ${errorMessage(cause)}`;
			throw cause;
		}
	}

	/** Network failures never block container status; the drawer shows them. */
	async function refreshNetworks() {
		try {
			await networkReads.run(
				(signal) => requestJson<NetworkData[]>('/api/networks', { signal }),
				(value) => {
					networks = value;
					networkError = '';
				}
			);
		} catch (cause) {
			networkError = `Network status may be outdated. ${errorMessage(cause)}`;
		}
	}

	/** Refresh after a container or network change, so rows and seats agree. */
	async function refreshContainersAndNetworks() {
		await Promise.all([refreshContainers(), refreshNetworks()]);
	}

	async function refreshWorkspaces() {
		try {
			await workspaceReads.run(
				(signal) => requestJson<LocalWorkspaceData[]>('/api/workspaces', { signal }),
				(value) => {
					workspaces = value;
					workspaceError = '';
				}
			);
		} catch (cause) {
			workspaceError = `Workspace status may be outdated. ${errorMessage(cause)}`;
			throw cause;
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
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			await refreshWorkspaces().catch(() => {});
			if (!stopped) timer = setTimeout(poll, 3000);
		}
		timer = setTimeout(poll, 3000);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
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

	// Network drawer: the target keeps the container ID, so polling updates the container.
	let networkTarget = $state<NetworkDrawerTarget | null>(null);
	const networkContainer = $derived(
		networkTarget ? (containers.find((c) => c.id === networkTarget?.containerId) ?? null) : null
	);

	function openNetworkDrawer(container: ContainerData, network?: string, seatIp?: string) {
		networkTarget = { containerId: container.id, network, seatIp };
		void refreshNetworks();
	}

	/** Remember or forget the connection, then refresh rows and seats. */
	async function handleNetworkConnected(
		container: ContainerData,
		request: ConnectRequest,
		remember: boolean
	) {
		if (remember) {
			const { network, ip, alias, setHostname } = request;
			networkMemory.remember(container, { network, ip, alias, setHostname });
		} else {
			networkMemory.forget(container, request.network);
		}
		await refreshContainersAndNetworks().catch(() => {});
	}

	/** Networks that a Compose project created or has containers on. */
	const projectNetworks = (projectName: string) =>
		networks.filter((network) => network.projects.includes(projectName));

	// Bootstrap modal
	let bootstrapModalOpen = $state(false);

	// Terminal manager state
	const WORKSPACE_ROOT = $derived(data.workspaceRoot);

	let terminalOpen = $state(false);
	let terminalSessions = $state<TerminalSession[]>([]);
	let activeTerminalId = $state<string | null>(null);
	let terminalRevision = 0;
	let terminalPoll = 0;
	const closedTerminalIds = new SvelteSet<string>();

	function openTerminalWith(id: string) {
		terminalOpen = true;
		activeTerminalId = id;
	}
	// "Open in terminal" in the Brain panel shows that command's tab.
	brainAccess.revealHandler = (executionId) => openTerminalWith(brainTabId(executionId));

	/** The first Brain tab, as a fallback when the last shell tab closes. */
	function firstBrainTabId(): string | null {
		const execution = brainAccess.tabs[0];
		return execution ? brainTabId(execution.id) : null;
	}

	function addTerminalSession(session: TerminalSession) {
		terminalRevision++;
		terminalSessions = [...terminalSessions, session];
	}

	function removeTerminalSessionLocally(id: string) {
		terminalRevision++;
		closedTerminalIds.add(id);
		terminalSessions = terminalSessions.filter((s) => s.id !== id);
		confirmedTerminalSessionIds.delete(id);
		if (activeTerminalId === id) {
			activeTerminalId = terminalSessions[terminalSessions.length - 1]?.id ?? firstBrainTabId();
		}
		if (terminalSessions.length === 0 && brainAccess.tabs.length === 0) terminalOpen = false;
	}

	async function closeTerminalSession(id: string) {
		await requestJson('/api/terminal/sessions', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id })
		});
		removeTerminalSessionLocally(id);
	}

	// Tracks which local tabs have been confirmed to exist server-side at least once, so a
	// freshly-opened tab isn't dropped by reconciliation before its WebSocket has connected.
	const confirmedTerminalSessionIds = new SvelteSet<string>();

	async function refreshTerminalSessions() {
		const poll = ++terminalPoll;
		const revision = terminalRevision;
		try {
			await terminalReads.run(
				(signal) => requestJson<TerminalSession[]>('/api/terminal/sessions', { signal }),
				(serverSessions) => {
					terminalError = '';
					reconcileTerminalSessions(serverSessions, poll, revision);
				}
			);
		} catch (cause) {
			terminalError = `Terminal status may be outdated. ${errorMessage(cause)}`;
		}
	}

	function reconcileTerminalSessions(
		serverSessions: TerminalSession[],
		poll: number,
		revision: number
	) {
		if (poll !== terminalPoll || revision !== terminalRevision) return;
		const serverIds = new SvelteSet(serverSessions.map((s) => s.id));
		const localIds = new SvelteSet(terminalSessions.map((s) => s.id));

		for (const id of serverIds) confirmedTerminalSessionIds.add(id);

		// Drop local tabs whose confirmed session no longer exists server-side (killed/exited
		// elsewhere); leave not-yet-confirmed tabs alone so brand-new tabs aren't removed early.
		const kept = terminalSessions.filter(
			(s) => serverIds.has(s.id) || !confirmedTerminalSessionIds.has(s.id)
		);
		// Add tabs for sessions that exist server-side but aren't open locally yet
		const added = serverSessions.filter((s) => !localIds.has(s.id) && !closedTerminalIds.has(s.id));

		if (kept.length !== terminalSessions.length || added.length > 0) {
			terminalSessions = [...kept, ...added];
			// Brain tabs are not shell sessions; keep one selected while its tab is open.
			if (
				activeTerminalId &&
				!brainExecutionIdOf(activeTerminalId) &&
				!terminalSessions.some((s) => s.id === activeTerminalId)
			) {
				activeTerminalId = terminalSessions[terminalSessions.length - 1]?.id ?? firstBrainTabId();
			}
			if (terminalSessions.length === 0 && brainAccess.tabs.length === 0) terminalOpen = false;
		}
	}

	function handleRunBackground() {
		// Workspace row is tracked server-side; refresh so it appears immediately
		void refreshWorkspaces().catch(() => {});
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
			class="z-10 border-b border-[#d8dee9] bg-[#e5e9f0] pt-[env(safe-area-inset-top)] transition-colors duration-300 md:sticky md:top-0 dark:border-[#434c5e] dark:bg-[#3b4252]"
		>
			<div
				class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 md:gap-4 md:py-4"
			>
				<!-- Logo & Title -->
				<div class="flex min-w-0 flex-1 items-center gap-3 md:flex-none">
					<img
						src={brandIcon}
						alt=""
						aria-hidden="true"
						width="48"
						height="48"
						class="size-10 shrink-0 md:size-12"
					/>
					<div class="min-w-0">
						<h1 class="text-xl leading-tight font-bold text-[#2e3440] dark:text-[#eceff4]">
							<span>Dev</span><span class="text-[#5e81ac] dark:text-[#88c0d0]">Harbour</span>
						</h1>
						<p class="hidden text-xs font-medium text-[#4c566a] sm:block dark:text-[#d8dee9]/70">
							Your development environments, together.
						</p>
					</div>
				</div>

				<!-- Phone: host controls open as a row below the counts -->
				<button
					type="button"
					onclick={() => (hostMenuOpen = !hostMenuOpen)}
					class="grid size-11 shrink-0 place-items-center rounded-full border border-[#d8dee9] bg-[#eceff4] text-[#4c566a] md:hidden dark:border-[#434c5e] dark:bg-[#2e3440] dark:text-[#d8dee9]"
					aria-label="Host controls"
					aria-expanded={hostMenuOpen}
					aria-controls="host-controls"
				>
					<MoreHorizontal size={20} />
				</button>

				<div class="flex w-full flex-wrap items-center gap-2 md:w-auto md:gap-4">
					<!-- Quick stats -->
					<div class="flex flex-wrap gap-2 text-sm font-medium md:gap-3">
						<div
							class="flex items-center gap-1.5 rounded-full border border-[#a3be8c]/20 bg-[#a3be8c]/10 px-3 py-1.5 text-[#a3be8c]"
						>
							<Power size={16} />
							<span>{runningCount} running <span class="text-xs opacity-70">total</span></span>
						</div>
						<div
							class="flex items-center gap-1.5 rounded-full border border-[#bf616a]/20 bg-[#bf616a]/10 px-3 py-1.5 text-[#bf616a]"
						>
							<Power size={16} />
							<span>{stoppedCount} stopped <span class="text-xs opacity-70">total</span></span>
						</div>
					</div>

					<div
						id="host-controls"
						class="{hostMenuOpen
							? 'flex'
							: 'hidden'} w-full flex-wrap items-center gap-2 md:flex md:w-auto md:gap-4"
					>
						<!-- Brain MCP access: shown only while the endpoint runs -->
						<BrainPanel access={brainAccess} />

						<!-- SSH host for VS Code remote connections -->
						<label
							class="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-[#d8dee9] bg-[#eceff4] px-3 py-1.5 md:min-h-0 md:flex-none dark:border-[#434c5e] dark:bg-[#2e3440]"
							title="SSH host for VS Code remote connections"
						>
							<Server size={14} class="shrink-0 text-[#4c566a] dark:text-[#d8dee9]/50" />
							<input
								type="text"
								placeholder="SSH host"
								bind:value={vscodeSshHost}
								aria-label="SSH host for VS Code remote connections"
								class="min-w-0 flex-1 border-none bg-transparent p-0 text-base text-[#4c566a] placeholder-[#4c566a]/50 outline-none md:w-36 md:flex-none md:text-xs dark:text-[#d8dee9]/70 dark:placeholder-[#d8dee9]/30"
							/>
						</label>

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
			</div>
		</header>

		<!-- Phone section bar: jumps between the three sections of the single page -->
		<nav
			aria-label="Sections"
			class="sticky top-0 z-10 border-b border-[#d8dee9] bg-[#eceff4]/95 px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 backdrop-blur md:hidden dark:border-[#434c5e] dark:bg-[#2e3440]/95"
		>
			<div
				class="grid grid-cols-3 gap-1 rounded-xl border border-[#d8dee9] bg-white p-1 dark:border-[#4c566a] dark:bg-[#3b4252]"
			>
				{#each SECTIONS as section (section.id)}
					<a
						href={`#${section.id}`}
						onclick={() => (currentSection = section.id)}
						aria-current={currentSection === section.id ? 'location' : undefined}
						class="flex min-h-11 items-center justify-center rounded-lg text-sm font-semibold transition-colors {currentSection ===
						section.id
							? 'bg-[#88c0d0] text-[#2e3440]'
							: 'text-[#4c566a] dark:text-[#d8dee9]/80'}">{section.label}</a
					>
				{/each}
			</div>
		</nav>

		<main class="mx-auto mt-4 max-w-7xl space-y-10 px-4 sm:px-6 md:mt-8 md:space-y-12">
			{#if containerError || workspaceError || terminalError || networkError}
				<div>
					<RequestError
						message={containerError}
						onRetry={() => void refreshContainers().catch(() => {})}
					/>
					<RequestError
						message={workspaceError}
						onRetry={() => void refreshWorkspaces().catch(() => {})}
					/>
					<RequestError message={terminalError} onRetry={() => void refreshTerminalSessions()} />
					<RequestError message={networkError} onRetry={() => void refreshNetworks()} />
				</div>
			{/if}
			<RequestError message={brainAccess.error} onRetry={() => void brainAccess.refresh()} />
			<!-- Section 1: Active Devcontainers -->
			<section id="devcontainers" class="scroll-mt-20 md:scroll-mt-28">
				<div
					class="mb-4 flex flex-wrap items-center gap-2 border-b border-[#d8dee9] pb-2 md:mb-6 dark:border-[#4c566a]"
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
								<span>{stoppedDevcontainerCount} stopped devcontainers</span>
							</button>
						{/if}
						<div
							class="hidden items-center gap-1 rounded-lg border border-[#d8dee9] bg-[#eceff4] p-0.5 md:flex dark:border-[#434c5e] dark:bg-[#2e3440]"
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
				{:else if devcontainerView === 'grid' && !isPhoneLayout}
					<div class="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6 xl:grid-cols-3">
						{#each visibleDevcontainers as container (container.id)}
							<DevcontainerCard
								{container}
								{vscodeSshHost}
								serviceProxyEnabled={data.serviceProxyEnabled}
								onRefresh={refreshContainersAndNetworks}
								onOpenTerminal={handleOpenTerminal}
								onConnectNetwork={openNetworkDrawer}
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
									serviceProxyEnabled={data.serviceProxyEnabled}
									onRefresh={refreshContainersAndNetworks}
									onOpenTerminal={handleOpenTerminal}
									onConnectNetwork={openNetworkDrawer}
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
				serviceProxyEnabled={data.serviceProxyEnabled}
				onOpenTerminal={handleOpenTerminal}
				onRefreshWorkspaces={refreshWorkspaces}
				onBootstrap={() => (bootstrapModalOpen = true)}
				onScrollToContainer={scrollToContainer}
				onRefreshContainers={refreshContainers}
			/>

			<!-- Section 3: Docker Services -->
			<section id="services" class="scroll-mt-20 md:scroll-mt-28">
				<div
					class="mb-4 flex flex-wrap items-center gap-2 border-b border-[#d8dee9] pb-2 md:mb-6 dark:border-[#4c566a]"
				>
					<Cpu size={20} class="text-[#4c566a] dark:text-[#d8dee9]/70" />
					<h2 class="text-xl font-extrabold text-[#2e3440] dark:text-[#eceff4]">Docker Services</h2>
					<span
						class="ml-2 hidden text-sm font-medium text-[#4c566a] sm:inline dark:text-[#d8dee9]/60"
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
						<div class="divide-y divide-[#d8dee9]/60 dark:divide-[#4c566a]/60">
							{#each composeGroups as group (group.projectName)}
								<ComposeGroupRow
									projectName={group.projectName}
									containers={group.containers}
									{vscodeSshHost}
									serviceProxyEnabled={data.serviceProxyEnabled}
									servicePorts={data.servicePorts}
									serviceAccess={data.serviceAccess}
									onRefresh={refreshContainersAndNetworks}
									onOpenTerminal={handleOpenTerminal}
									networks={projectNetworks(group.projectName)}
									{devcontainers}
									onConnectNetwork={openNetworkDrawer}
								/>
							{/each}
							{#each standaloneSandboxes as container (container.id)}
								<SandboxRow
									{container}
									{vscodeSshHost}
									serviceProxyEnabled={data.serviceProxyEnabled}
									servicePorts={data.servicePorts}
									serviceAccess={data.serviceAccess}
									standalone
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

	<!-- Network drawer: connect a running devcontainer to an existing network -->
	<NetworkDrawer
		container={networkContainer}
		network={networkTarget?.network}
		seatIp={networkTarget?.seatIp}
		{networks}
		networksError={networkError}
		onClose={() => (networkTarget = null)}
		onConnected={handleNetworkConnected}
	/>

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
