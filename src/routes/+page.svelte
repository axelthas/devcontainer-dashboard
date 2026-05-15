<script lang="ts">
	import { Sun, Moon, Layers, Box, Cpu, Power, Play } from 'lucide-svelte';
	import { untrack } from 'svelte';
	import type { ContainerData, LocalWorkspaceData } from '$lib/types';
	import DevcontainerCard from '$lib/components/DevcontainerCard.svelte';
	import SandboxRow from '$lib/components/SandboxRow.svelte';
	import ComposeGroupRow from '$lib/components/ComposeGroupRow.svelte';
	import LocalWorkspaces from '$lib/components/LocalWorkspaces.svelte';
	import BootstrapModal from '$lib/components/BootstrapModal.svelte';
	import TerminalManager from '$lib/components/TerminalManager.svelte';

	interface Props {
		data: { containers: ContainerData[]; hostname: string; workspaces: LocalWorkspaceData[] };
	}

	let { data }: Props = $props();

	// untrack prevents svelte from treating data.containers as a reactive dep;
	// polling handles subsequent updates
	let containers = $state<ContainerData[]>(untrack(() => data.containers));
	const hostname = data.hostname;
	const initialWorkspaces = untrack(() => data.workspaces);
	let dark = $state(true);

	const THEME_KEY = 'devcontainer-dashboard-theme';

	$effect(() => {
		const stored = localStorage.getItem(THEME_KEY);
		if (stored !== null) dark = stored === 'dark';
	});

	$effect(() => {
		localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
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

	// Bootstrap modal
	let bootstrapModalOpen = $state(false);

	// Terminal manager state
	const WORKSPACE_ROOT = '/bootstrap_workspaces';

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

	function handleRunInTerminal(command: string, name: string) {
		const id = crypto.randomUUID();
		addTerminalSession({ id, name, command, cwd: WORKSPACE_ROOT });
		openTerminalWith(id);
	}

	function handleOpenTerminal(id: string, command: string, name: string, cwd: string) {
		addTerminalSession({ id, name, command, cwd });
		openTerminalWith(id);
	}
</script>

<div class={dark ? 'dark' : ''}>
<div
	class="min-h-screen bg-[#eceff4] text-[#2e3440] dark:bg-[#2e3440] dark:text-[#d8dee9] font-sans pb-40 transition-colors duration-300"
>
	<!-- Header -->
	<header
		class="bg-[#e5e9f0] dark:bg-[#3b4252] border-b border-[#d8dee9] dark:border-[#434c5e] sticky top-0 z-10 transition-colors duration-300"
	>
		<div class="max-w-7xl mx-auto px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
			<!-- Logo & Title -->
			<div class="flex items-center gap-3">
				<div class="p-2 bg-[#88c0d0] rounded-lg shadow-md">
					<Layers size={24} class="text-[#2e3440]" />
				</div>
				<div>
					<h1 class="text-xl font-bold text-[#2e3440] dark:text-[#eceff4] leading-tight">
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
						class="flex items-center gap-1.5 text-[#a3be8c] bg-[#a3be8c]/10 px-3 py-1.5 rounded-full border border-[#a3be8c]/20"
					>
						<Power size={16} />
						<span>{runningCount} Running</span>
					</div>
					<div
						class="flex items-center gap-1.5 text-[#bf616a] bg-[#bf616a]/10 px-3 py-1.5 rounded-full border border-[#bf616a]/20"
					>
						<Power size={16} />
						<span>{stoppedCount} Stopped</span>
					</div>
				</div>

				<!-- Run Bootstrap button -->
				<button
					onclick={() => (bootstrapModalOpen = true)}
					class="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#88c0d0] hover:bg-[#81a1c1] text-[#2e3440] font-semibold text-sm transition-colors"
					type="button"
				>
					<Play size={16} />
					Run Bootstrap
				</button>

				<!-- Theme toggle -->
				<button
					onclick={() => (dark = !dark)}
					class="p-2 rounded-full border bg-[#eceff4] dark:bg-[#2e3440] border-[#d8dee9] dark:border-[#434c5e] text-[#4c566a] dark:text-[#ebcb8b] hover:opacity-80 transition-opacity"
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

	<main class="max-w-7xl mx-auto px-6 mt-8 space-y-12">
		<!-- Section 1: Active Devcontainers -->
		<section>
			<div
				class="flex items-center gap-2 mb-6 border-b border-[#d8dee9] dark:border-[#4c566a] pb-2"
			>
				<Box size={20} class="text-[#5e81ac] dark:text-[#81a1c1]" />
				<h2 class="text-xl font-extrabold text-[#2e3440] dark:text-[#eceff4]">Active Devcontainers</h2>
			</div>

			{#if devcontainers.length === 0}
				<p class="text-[#4c566a] dark:text-[#d8dee9]/60 italic">No devcontainers found.</p>
			{:else}
				<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
					{#each devcontainers as container (container.id)}
						<DevcontainerCard {container} {hostname} onRefresh={refreshContainers} />
					{/each}
				</div>
			{/if}
		</section>

		<!-- Section 2: Local Workspaces -->
		<LocalWorkspaces workspaceRoot={WORKSPACE_ROOT} workspaces={initialWorkspaces} onOpenTerminal={handleOpenTerminal} />

		<!-- Section 3: Sandbox Services -->
		<section>
			<div
				class="flex items-center gap-2 mb-6 border-b border-[#d8dee9] dark:border-[#4c566a] pb-2"
			>
				<Cpu size={20} class="text-[#4c566a] dark:text-[#d8dee9]/70" />
				<h2 class="text-xl font-extrabold text-[#2e3440] dark:text-[#eceff4]">Sandbox Services</h2>
				<span class="text-sm font-medium text-[#4c566a] dark:text-[#d8dee9]/60 ml-2"
					>(Docker Compose, Local DBs, etc.)</span
				>
			</div>

			{#if composeGroups.length === 0 && standaloneSandboxes.length === 0}
				<div
					class="rounded-xl border shadow-sm overflow-hidden bg-white dark:bg-[#3b4252] border-[#d8dee9] dark:border-[#4c566a]"
				>
					<div class="p-8 text-center text-[#4c566a] dark:text-[#d8dee9]/60 italic">
						No external services exposing ports.
					</div>
				</div>
			{:else}
				<div
					class="rounded-xl border shadow-sm overflow-hidden bg-white dark:bg-[#3b4252] border-[#d8dee9] dark:border-[#4c566a]"
				>
					<div class="divide-y divide-[#d8dee9] dark:divide-[#4c566a]">
						{#each composeGroups as group (group.projectName)}
							<ComposeGroupRow
								projectName={group.projectName}
								containers={group.containers}
								{hostname}
								onRefresh={refreshContainers}
							/>
						{/each}
						{#each standaloneSandboxes as container (container.id)}
							<SandboxRow {container} {hostname} onRefresh={refreshContainers} />
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
		onRunInTerminal={handleRunInTerminal}
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
