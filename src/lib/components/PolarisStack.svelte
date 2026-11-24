<script lang="ts">
	import {
		Play,
		Square,
		ChevronDown,
		ChevronUp,
		Network,
		Loader2,
		BookOpen,
		Trash2
	} from 'lucide-svelte';
	import { page } from '$app/state';
	import { harnessAddress, isHarnessLoopbackOnly, type HarnessEndpoint } from '$lib/harness';
	import type { PolarisInstance, PolarisMode } from '$lib/types';
	import SandboxRow from './SandboxRow.svelte';
	import { untrack } from 'svelte';

	interface Props {
		instance: PolarisInstance;
		vscodeSshHost: string;
		onRefresh: () => Promise<void>;
		onOpenTerminal?: (id: string, command: string, name: string, cwd: string) => void;
		nginxDomain?: string;
	}

	let { instance, vscodeSshHost, onRefresh, onOpenTerminal, nginxDomain }: Props = $props();

	let expanded = $state(true);
	let loadingAction = $state<string | null>(null);
	let modeLoading = $state<PolarisMode | null>(null);
	let currentMode = $state<PolarisMode | undefined>(untrack(() => instance.currentMode));
	let deleteLoading = $state(false);
	let confirmDelete = $state(false);

	// Sync from server whenever it has a defined value.
	// Use a separate guard so a locally-set mode isn't wiped by the next poll
	// returning undefined (external instances not yet persisted).
	$effect(() => {
		const serverMode = instance.currentMode;
		if (serverMode !== undefined) currentMode = serverMode;
	});

	const MODES: {
		value: PolarisMode;
		label: string;
		color: string;
		activeColor: string;
		description: string;
	}[] = [
		{
			value: 'training',
			label: 'Training',
			color: 'hover:text-[#a3be8c] hover:bg-[#a3be8c]/10',
			activeColor: 'text-[#a3be8c] bg-[#a3be8c]/15 border border-[#a3be8c]/40 font-bold',
			description:
				'Uruchamia tryb szkoleniowy (symulowany czas, Orion w trybie pseudo-pilot). Wywołuje supervisorctl start mode-training wewnątrz każdego kontenera.'
		},
		{
			value: 'playback',
			label: 'Playback',
			color: 'hover:text-[#ebcb8b] hover:bg-[#ebcb8b]/10',
			activeColor: 'text-[#ebcb8b] bg-[#ebcb8b]/15 border border-[#ebcb8b]/40 font-bold',
			description:
				'Odtwarza nagranie lotów z katalogu /record (CDR). Wywołuje supervisorctl start mode-playback.'
		},
		{
			value: 'testing',
			label: 'Testing',
			color: 'hover:text-[#d08770] hover:bg-[#d08770]/10',
			activeColor: 'text-[#d08770] bg-[#d08770]/15 border border-[#d08770]/40 font-bold',
			description:
				'Tryb testowy — oprogramowanie w konfiguracji testowej. Wywołuje supervisorctl start mode-testing.'
		},
		{
			value: 'operational',
			label: 'Operational',
			color: 'hover:text-[#bf616a] hover:bg-[#bf616a]/10',
			activeColor: 'text-[#bf616a] bg-[#bf616a]/15 border border-[#bf616a]/40 font-bold',
			description:
				'Tryb operacyjny — konfiguracja produkcyjna. Wywołuje supervisorctl start mode-operational.'
		}
	];

	const runningCount = $derived(instance.containers.filter((c) => c.state === 'running').length);
	const totalCount = $derived(instance.containers.length);
	const isAnyRunning = $derived(runningCount > 0);

	const sortedContainers = $derived(
		[...instance.containers].sort((a, b) => {
			const aIsSupport = a.name.includes('mysql') || a.name.includes('tatoo');
			const bIsSupport = b.name.includes('mysql') || b.name.includes('tatoo');
			if (aIsSupport !== bIsSupport) return aIsSupport ? 1 : -1;
			const aRunning = a.state === 'running' ? 0 : 1;
			const bRunning = b.state === 'running' ? 0 : 1;
			return aRunning - bRunning || a.name.localeCompare(b.name);
		})
	);

	const harnesses = $derived(instance.containers.flatMap((c) => c.harnesses ?? []));

	function harnessHint(harness: HarnessEndpoint): string {
		if (!harness.hostPort) return 'Sandbox network address: reachable only from the server';
		return isHarnessLoopbackOnly(harness)
			? 'Published on localhost: reachable on the server or through an SSH tunnel'
			: 'Published on the server: reachable from the network, without authentication';
	}

	const modeTargetIds = $derived(
		instance.containers
			.filter(
				(c) =>
					c.state === 'running' &&
					!c.name.toLowerCase().includes('mysql') &&
					!c.name.toLowerCase().includes('tatoo')
			)
			.map((c) => c.id)
	);

	async function handleStackAction(action: 'start' | 'stop') {
		if (!instance.managedByDashboard) return;
		loadingAction = action;

		try {
			const res = await fetch(`/api/stacks/${instance.id}/${action}`, { method: 'POST' });
			if (!res.ok) {
				console.error(`[${action}] failed:`, await res.text().catch(() => ''));
				loadingAction = null;
				return;
			}
		} catch (err) {
			console.error(`[${action}] fetch error:`, err);
			loadingAction = null;
			return;
		}

		if (action === 'stop') {
			await new Promise((r) => setTimeout(r, 2000));
			await onRefresh();
			loadingAction = null;
		} else {
			// start is async on the server (202). Poll every 3 s until containers running
			// or 3-minute deadline.
			const deadline = Date.now() + 3 * 60 * 1000;
			const poll = async () => {
				await onRefresh();
				const running = instance.containers.some((c) => c.state === 'running');
				if (!running && Date.now() < deadline) {
					setTimeout(poll, 3000);
				} else {
					loadingAction = null;
				}
			};
			setTimeout(poll, 3000);
		}
	}

	async function handleDelete() {
		if (!confirmDelete) {
			// First click: ask for confirmation
			confirmDelete = true;
			// Auto-reset after 4 s if not confirmed
			setTimeout(() => {
				confirmDelete = false;
			}, 4000);
			return;
		}
		deleteLoading = true;
		try {
			await fetch(`/api/stacks/${instance.id}`, { method: 'DELETE' });
			await onRefresh();
		} finally {
			deleteLoading = false;
			confirmDelete = false;
		}
	}

	async function handleModeSwitch(mode: PolarisMode) {
		if (modeTargetIds.length === 0) return;
		modeLoading = mode;
		try {
			const res = await fetch(`/api/stacks/${instance.id}/mode/${mode}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ containerIds: modeTargetIds })
			});
			if (res.ok) currentMode = mode;
			await onRefresh();
		} finally {
			modeLoading = null;
		}
	}
</script>

<div
	class="overflow-hidden rounded-xl border border-[#d8dee9]
	       bg-white shadow-sm dark:border-[#4c566a] dark:bg-[#3b4252]"
>
	<!-- Stack header -->
	<div
		class="flex flex-col gap-3 border-b border-[#d8dee9] bg-[#e5e9f0]/60 px-5 py-3
		       sm:flex-row sm:items-center
		       sm:justify-between dark:border-[#4c566a] dark:bg-[#3b4252]"
	>
		<!-- Left: title + metadata -->
		<div class="flex min-w-0 items-center gap-3">
			<button
				onclick={() => (expanded = !expanded)}
				class="shrink-0 rounded p-1 transition-colors hover:bg-[#d8dee9] dark:hover:bg-[#4c566a]"
				title={expanded ? 'Collapse' : 'Expand'}
			>
				{#if expanded}
					<ChevronUp size={16} class="text-[#4c566a] dark:text-[#d8dee9]/70" />
				{:else}
					<ChevronDown size={16} class="text-[#4c566a] dark:text-[#d8dee9]/70" />
				{/if}
			</button>

			<div class="min-w-0">
				<div class="flex flex-wrap items-center gap-2">
					<span class="text-base leading-tight font-extrabold text-[#2e3440] dark:text-[#eceff4]">
						{instance.id}
					</span>
					<span
						class="rounded bg-[#d8dee9] px-1.5 py-0.5 font-mono
						       text-[10px] tracking-wide text-[#4c566a] uppercase dark:bg-[#434c5e] dark:text-[#d8dee9]/80"
					>
						{instance.type}
					</span>
					{#if !instance.managedByDashboard}
						<span
							class="rounded border border-[#ebcb8b]/30 bg-[#ebcb8b]/20 px-1.5
							       py-0.5 font-mono text-[10px] tracking-wide text-[#b58900] uppercase dark:text-[#ebcb8b]"
						>
							external
						</span>
					{/if}
				</div>
				<div class="mt-0.5 flex items-center gap-3 text-xs text-[#4c566a] dark:text-[#d8dee9]/60">
					<span class="flex items-center gap-1">
						<Network size={11} />
						{instance.subnet}
					</span>
					<span>
						<span class="text-[#a3be8c]">{runningCount}</span>/{totalCount} containers
					</span>
					{#if currentMode}
						{@const modeInfo = MODES.find((m) => m.value === currentMode)}
						<span
							class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase
						             {modeInfo?.activeColor ?? ''}"
						>
							{currentMode}
						</span>
					{/if}
				</div>
			</div>
		</div>

		<!-- Right: mode selector + stack controls -->
		<div class="flex flex-wrap items-center gap-2">
			<!-- Mode switch pills (only when any container is running) -->
			{#if isAnyRunning}
				<div
					class="flex items-center gap-1 rounded-lg border border-[#d8dee9]
					       bg-[#eceff4] p-1 dark:border-[#434c5e] dark:bg-[#2e3440]"
				>
					<BookOpen size={13} class="ml-1 shrink-0 text-[#4c566a] dark:text-[#d8dee9]/50" />
					{#each MODES as m (m.value)}
						{@const isActive = currentMode === m.value}
						{@const isLoading = modeLoading === m.value}
						<button
							onclick={() => handleModeSwitch(m.value)}
							disabled={modeLoading !== null || modeTargetIds.length === 0}
							title={m.description}
							class="rounded px-2.5 py-1 text-[11px] transition-all
							       disabled:cursor-not-allowed
							       {isActive
								? `${m.activeColor} cursor-default`
								: `text-[#4c566a] dark:text-[#d8dee9]/70 ${m.color} disabled:opacity-50`}"
						>
							{#if isLoading}
								<Loader2 size={12} class="inline animate-spin" />
							{:else}
								{m.label}
							{/if}
						</button>
					{/each}
					{#if !currentMode}
						<span class="mr-1 ml-1 text-[10px] text-[#4c566a]/50 italic dark:text-[#d8dee9]/30"
							>—</span
						>
					{/if}
				</div>
			{/if}

			<!-- Stack start / stop (only for dashboard-managed instances) -->
			{#if instance.managedByDashboard}
				<div
					class="flex items-center gap-1 rounded-xl border border-[#d8dee9] bg-[#eceff4]
					       p-1 shadow-sm dark:border-[#434c5e] dark:bg-[#2e3440]"
				>
					{#if isAnyRunning}
						<button
							onclick={() => handleStackAction('stop')}
							disabled={loadingAction !== null}
							class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-[#4c566a]
							       transition-colors hover:bg-[#e5e9f0] hover:text-[#bf616a] disabled:cursor-not-allowed
							       disabled:opacity-50 dark:text-[#d8dee9]
							       dark:hover:bg-[#3b4252] dark:hover:text-[#bf616a]"
							title="Stop all containers in this stack"
						>
							{#if loadingAction === 'stop'}
								<Loader2 size={14} class="animate-spin" />
							{:else}
								<Square size={14} class="fill-current" />
							{/if}
							Stop stack
						</button>
					{:else}
						<button
							onclick={() => handleStackAction('start')}
							disabled={loadingAction !== null}
							class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-[#4c566a]
							       transition-colors hover:bg-[#e5e9f0] hover:text-[#a3be8c] disabled:cursor-not-allowed
							       disabled:opacity-50 dark:text-[#d8dee9]
							       dark:hover:bg-[#3b4252] dark:hover:text-[#a3be8c]"
							title="Start all containers in this stack"
						>
							{#if loadingAction === 'start'}
								<Loader2 size={14} class="animate-spin" />
							{:else}
								<Play size={14} class="fill-current" />
							{/if}
							Start stack
						</button>
					{/if}
				</div>

				<!-- Delete instance button -->
				<button
					onclick={handleDelete}
					disabled={deleteLoading || loadingAction !== null}
					class="rounded-lg p-1.5 transition-colors disabled:opacity-40
					       {confirmDelete
						? 'border border-[#bf616a]/40 bg-[#bf616a]/15 text-[#bf616a]'
						: 'text-[#4c566a]/50 hover:bg-[#bf616a]/10 hover:text-[#bf616a] dark:text-[#d8dee9]/40'}"
					title={confirmDelete
						? 'Click again to confirm deletion'
						: 'Delete this instance (stops stack + removes files)'}
				>
					{#if deleteLoading}
						<Loader2 size={14} class="animate-spin" />
					{:else}
						<Trash2 size={14} />
					{/if}
				</button>
			{/if}
		</div>
	</div>

	<!-- Test harness addresses -->
	{#if expanded && harnesses.length > 0}
		<div
			class="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-[#d8dee9] px-5 py-2.5
			       text-xs dark:border-[#4c566a]"
		>
			<span class="font-bold text-[#4c566a] dark:text-[#d8dee9]/80">AI harness</span>
			{#each harnesses as harness (harness.kind)}
				<span class="flex items-center gap-1.5" title={harnessHint(harness)}>
					<span class="text-[#4c566a] dark:text-[#d8dee9]/60">{harness.label}</span>
					<code class="font-mono text-[#2e3440] select-all dark:text-[#eceff4]">
						{harnessAddress(harness, page.url.hostname)}
					</code>
				</span>
			{/each}
		</div>
	{/if}

	<!-- Container list -->
	{#if expanded}
		{#if sortedContainers.length === 0}
			<div class="p-6 text-center text-sm text-[#4c566a] italic dark:text-[#d8dee9]/60">
				No containers found. Start the stack to bring them up.
			</div>
		{:else}
			<div class="divide-y divide-[#d8dee9] dark:divide-[#4c566a]">
				{#each sortedContainers as container (container.id)}
					<SandboxRow
						{container}
						{vscodeSshHost}
						{onRefresh}
						{onOpenTerminal}
						nginxDomain={instance.novncMode === 'local' ? undefined : nginxDomain}
					/>
				{/each}
			</div>
		{/if}
	{/if}
</div>
