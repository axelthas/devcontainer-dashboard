<script lang="ts">
	/**
	 * Compose sandbox controls for one Git repository: select files and services, resolve the
	 * configuration, and run one allowlisted lifecycle action at a time.
	 * The server validates every selection again; this component only proposes it.
	 */
	import {
		Boxes,
		FileText,
		Hammer,
		Loader,
		Network,
		Play,
		RefreshCw,
		ScrollText,
		Square,
		TriangleAlert,
		X
	} from 'lucide-svelte';
	import { onDestroy, untrack } from 'svelte';
	import { errorMessage, latestRequest, requestJson } from '$lib/requests';
	import { generateId } from '$lib/index';
	import {
		COMPOSE_ACTION_LABELS,
		COMPOSE_ACTIONS,
		composeActionCommand,
		composeDirectory,
		composeLogsCommand,
		composeQuery,
		composeSandboxKind,
		defaultComposeSelection,
		parseProfiles,
		shellCommand,
		withDependencies,
		type ComposeAction,
		type ComposeSelection
	} from '$lib/composeCommands';
	import type { ComposeInspection, ComposeRunData, RepositoryData } from '$lib/types';
	import RequestError from './RequestError.svelte';
	import TerminalTab from './TerminalTab.svelte';

	interface Props {
		repo: RepositoryData;
		onRefresh: () => Promise<void>;
		onRefreshContainers?: () => Promise<void>;
		onOpenTerminal: (id: string, command: string, name: string, cwd: string) => void;
		onOpenLog: (id: string, title: string) => void;
	}
	let { repo, onRefresh, onRefreshContainers, onOpenTerminal, onOpenLog }: Props = $props();

	const STORAGE_KEY = 'devcontainer-dashboard-compose-selections';
	const SERVICE_STORAGE_KEY = 'devcontainer-dashboard-compose-services';
	interface StoredSelection {
		files: string[];
		envFile: string;
		profiles: string;
	}

	/** Read all saved selections; storage errors mean no saved selection. */
	function readStoredSelections(): Record<string, StoredSelection> {
		if (typeof localStorage === 'undefined') return {};
		try {
			return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
				string,
				StoredSelection
			>;
		} catch {
			return {};
		}
	}

	/** The storage key that other clones of the same repository fall back to. */
	function nameKey(name: string): string {
		return `name:${name}`;
	}

	/**
	 * Read the excluded services of every sandbox kind. An exclusion list, not an inclusion
	 * list, is saved, so a service that a later revision adds is selected by default.
	 */
	function readExcludedServices(): Record<string, string[]> {
		if (typeof localStorage === 'undefined') return {};
		try {
			const value = JSON.parse(localStorage.getItem(SERVICE_STORAGE_KEY) ?? '{}');
			return value && typeof value === 'object' ? (value as Record<string, string[]>) : {};
		} catch {
			return {};
		}
	}

	/** Restore a saved selection only when its files still exist in the repository. */
	const initial = untrack(() => {
		const available = repo.composeFiles ?? [];
		const all = readStoredSelections();
		const stored = all[repo.path] ?? all[nameKey(repo.name)];
		const files = stored?.files?.filter((file) => available.includes(file)) ?? [];
		return {
			files: files.length > 0 ? files : defaultComposeSelection(available),
			envFile: stored?.envFile ?? '',
			profiles: stored?.profiles ?? ''
		};
	});

	let selectedFiles = $state<string[]>(initial.files);
	let envFile = $state(initial.envFile);
	let profilesText = $state(initial.profiles);
	let excludedByKind = $state<Record<string, string[]>>(readExcludedServices());

	const files = $derived(repo.composeFiles ?? []);
	const directories = $derived([...new Set(files.map(composeDirectory))]);
	const directory = $derived(composeDirectory(selectedFiles[0] ?? files[0] ?? ''));
	const directoryFiles = $derived(files.filter((file) => composeDirectory(file) === directory));
	const selection = $derived<ComposeSelection>({
		files: selectedFiles,
		profiles: parseProfiles(profilesText),
		...(envFile.trim() ? { envFile: envFile.trim() } : {})
	});
	const selectionKey = $derived(JSON.stringify(selection));

	const reads = latestRequest();
	let inspection = $state<ComposeInspection | null>(null);
	let inspectedKey = $state('');
	let inspecting = $state(false);
	let inspectError = $state('');
	let actionError = $state('');
	let starting = $state<string | null>(null);
	let disposed = false;
	onDestroy(() => {
		disposed = true;
		reads.cancel();
	});

	const run = $derived(repo.composeRun);
	/** Actions need a check of exactly the current selection. */
	const fresh = $derived(inspection !== null && inspectedKey === selectionKey);
	const blocked = $derived(
		!fresh || inspection?.ownership === 'other' || run?.status === 'running' || starting !== null
	);
	const runningCount = $derived(
		inspection?.containers.filter((container) => container.state === 'running').length ?? 0
	);

	// Service selection. Clones of one solution share a sandbox kind and its saved selection.
	const sandboxKind = $derived(composeSandboxKind(repo.name, selectedFiles));
	const excluded = $derived(
		Array.isArray(excludedByKind[sandboxKind]) ? excludedByKind[sandboxKind] : []
	);
	const serviceNames = $derived(inspection?.services.map((service) => service.name) ?? []);
	/** Services that the operator selected. */
	const chosen = $derived(serviceNames.filter((name) => !excluded.includes(name)));
	/** Selected services plus their transitive depends_on services, in config order. */
	const effective = $derived(withDependencies(inspection?.services ?? [], chosen));
	/** Services that run only because a selected service depends on them. */
	const implied = $derived(effective.filter((name) => !chosen.includes(name)));
	const allSelected = $derived(effective.length === serviceNames.length);
	/** Service arguments for Compose; no arguments means every service. */
	const serviceArgs = $derived(allSelected ? [] : effective);
	/** Running services outside the selection; Build and Start do not change them. */
	const runningOutside = $derived(
		serviceNames.filter(
			(name) =>
				!effective.includes(name) &&
				(inspection?.containers ?? []).some(
					(container) => container.service === name && container.state === 'running'
				)
		)
	);

	const commandPreview = $derived(
		selectedFiles.length === 0
			? ''
			: COMPOSE_ACTIONS.map((action) =>
					shellCommand(composeActionCommand(repo.path, selection, action, actionServices(action)))
				).join('\n')
	);

	// Save the selection per repository path, and per repository name for other clones.
	$effect(() => {
		const entry: StoredSelection = { files: selectedFiles, envFile, profiles: profilesText };
		try {
			const all = readStoredSelections();
			all[repo.path] = entry;
			all[nameKey(repo.name)] = entry;
			localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
		} catch {
			// ignore storage errors
		}
	});

	// Resolve the configuration on open and after each selection change.
	$effect(() => {
		const key = selectionKey;
		const timer = setTimeout(() => {
			if (key) void inspect();
		}, 300);
		return () => clearTimeout(timer);
	});

	/** Resolve the current selection; only the newest response may apply. */
	async function inspect() {
		if (selectedFiles.length === 0) {
			reads.cancel();
			inspection = null;
			inspecting = false;
			inspectError = 'Select at least one Compose file.';
			return;
		}
		const key = selectionKey;
		const query = composeQuery(repo.path, selection);
		inspecting = true;
		inspectError = '';
		try {
			const applied = await reads.run(
				(signal) => requestJson<ComposeInspection>(`/api/compose?${query}`, { signal }),
				(value) => {
					inspection = value;
					inspectedKey = key;
				}
			);
			if (applied && !disposed) inspecting = false;
		} catch (cause) {
			if (!disposed) {
				inspection = null;
				inspectError = errorMessage(cause);
				inspecting = false;
			}
		}
	}

	/** Keep files in discovery order, which is the Compose merge order shown to the operator. */
	function toggleFile(file: string) {
		const next = selectedFiles.includes(file)
			? selectedFiles.filter((item) => item !== file)
			: [...selectedFiles, file];
		selectedFiles = directoryFiles.filter((item) => next.includes(item));
	}

	/** A new project directory starts with its default selection. */
	function selectDirectory(next: string) {
		selectedFiles = defaultComposeSelection(files, next);
	}

	/**
	 * Save the excluded services of the current sandbox kind. Read storage again first, so
	 * another tab's choices for other kinds stay. An empty list removes the entry.
	 */
	function saveExcluded(next: string[]) {
		const all = Object.fromEntries(
			Object.entries(readExcludedServices()).filter(([kind]) => kind !== sandboxKind)
		);
		if (next.length > 0) all[sandboxKind] = next;
		excludedByKind = all;
		try {
			localStorage.setItem(SERVICE_STORAGE_KEY, JSON.stringify(all));
		} catch {
			// ignore storage errors
		}
	}

	/** Select or deselect one service. Dependencies follow the selection. */
	function toggleService(name: string) {
		saveExcluded(
			excluded.includes(name) ? excluded.filter((item) => item !== name) : [...excluded, name]
		);
	}

	/** Select or deselect every service. Keep exclusions for services of other profiles. */
	function selectAllServices(selected: boolean) {
		const others = excluded.filter((name) => !serviceNames.includes(name));
		saveExcluded(selected ? others : [...others, ...serviceNames]);
	}

	/** Stop always applies to the whole project; the other actions use the selected services. */
	function actionServices(action: ComposeAction): string[] {
		return action === 'stop' ? [] : serviceArgs;
	}

	/**
	 * Start one action. An empty service list means every service. The server checks the
	 * selection, the services, and the live stack again.
	 */
	async function start(action: ComposeAction, services: string[], key: string = action) {
		if (blocked) return;
		starting = key;
		actionError = '';
		try {
			await requestJson('/api/compose/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					repoPath: repo.path,
					repoName: repo.name,
					action,
					...selection,
					...(services.length > 0 ? { services } : {})
				})
			});
			await onRefresh();
		} catch (cause) {
			if (!disposed) actionError = errorMessage(cause);
		} finally {
			if (!disposed) starting = null;
		}
	}

	/** Cancel a running action, or dismiss a finished one and delete its log. */
	async function removeRun(id: string) {
		actionError = '';
		try {
			await requestJson('/api/compose/run', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id })
			});
			await onRefresh();
		} catch (cause) {
			if (!disposed) actionError = errorMessage(cause);
		}
	}

	/** Refresh the row, the Docker services, and the stack state after a process exits. */
	function runExited() {
		void onRefresh().catch(() => {});
		void onRefreshContainers?.().catch(() => {});
		void inspect();
	}

	/**
	 * Follow logs of the selected services in an operator terminal. Closing the tab stops only
	 * the log view.
	 */
	function openLogs() {
		if (!inspection || !fresh) return;
		onOpenTerminal(
			generateId(),
			shellCommand(composeLogsCommand(repo.path, selection, serviceArgs)),
			`Logs ${inspection.projectName}`,
			inspection.projectDirectory
		);
	}

	/** Name the action of a run, with its services when it ran on a subset. */
	function runLabel(activeRun: ComposeRunData): string {
		const label = COMPOSE_ACTION_LABELS[activeRun.action];
		const services = activeRun.services ?? [];
		return services.length > 0 ? `${label} ${services.join(', ')}` : label;
	}

	/** Describe a container set for one service. */
	function serviceState(service: string): { label: string; tone: string } {
		const states = (inspection?.containers ?? [])
			.filter((container) => container.service === service)
			.map((container) => container.state);
		if (states.length === 0) return { label: 'not created', tone: 'bg-[#4c566a]/40' };
		if (states.includes('running')) return { label: states.join(', '), tone: 'bg-[#a3be8c]' };
		return { label: states.join(', '), tone: 'bg-[#bf616a]' };
	}
</script>

{#snippet actionButton(action: ComposeAction, tone: string)}
	<button
		type="button"
		onclick={() => void start(action, actionServices(action))}
		disabled={blocked || (action !== 'stop' && effective.length === 0)}
		title={action === 'stop' ? 'Stop every service of this project' : undefined}
		class="flex items-center gap-1 rounded-lg border border-[#d8dee9] bg-white px-2.5 py-1 text-xs font-medium {tone} transition-colors hover:bg-[#e5e9f0] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#4c566a] dark:bg-[#2e3440] dark:hover:bg-[#434c5e]"
	>
		{#if starting === action}
			<Loader size={12} class="animate-spin" />
		{:else if action === 'build'}
			<Hammer size={12} />
		{:else if action === 'stop'}
			<Square size={12} />
		{:else}
			<Play size={12} />
		{/if}
		{COMPOSE_ACTION_LABELS[action]}
	</button>
{/snippet}

<div
	class="border-b border-[#d8dee9]/60 bg-[#e5e9f0]/50 py-3 pr-5 pl-12 dark:border-[#4c566a]/60 dark:bg-[#3b4252]/40"
	role="region"
	aria-label={`Compose sandbox: ${repo.name}`}
>
	<div class="flex flex-wrap items-center gap-2">
		<Boxes size={14} class="text-[#5e81ac] dark:text-[#88c0d0]" />
		<span class="text-sm font-semibold text-[#2e3440] dark:text-[#eceff4]">Compose sandbox</span>
		{#if inspection}
			<span
				class="rounded-full border border-[#81a1c1]/30 bg-[#81a1c1]/10 px-2 py-0.5 text-xs font-medium text-[#5e81ac] dark:text-[#81a1c1]"
				title="Effective Compose project name">{inspection.projectName}</span
			>
			<span class="text-xs text-[#4c566a] dark:text-[#d8dee9]/60"
				>{runningCount} running · {inspection.services.length}
				{inspection.services.length === 1 ? 'service' : 'services'}</span
			>
		{/if}
		<button
			type="button"
			onclick={() => void inspect()}
			disabled={inspecting}
			class="ml-auto flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-[#4c566a] transition-colors hover:bg-[#d8dee9]/60 disabled:opacity-50 dark:text-[#d8dee9]/70 dark:hover:bg-[#4c566a]"
			title="Resolve the configuration again"
		>
			<RefreshCw size={12} class={inspecting ? 'animate-spin' : ''} />
			Check
		</button>
	</div>

	<div class="mt-3 grid gap-3 text-xs md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
		<fieldset class="min-w-0">
			<legend class="mb-1 font-semibold text-[#4c566a] dark:text-[#d8dee9]/70">
				Compose files, in merge order
			</legend>
			{#if directories.length > 1}
				<select
					aria-label="Project directory"
					value={directory}
					onchange={(event) => selectDirectory(event.currentTarget.value)}
					class="mb-1.5 rounded border border-[#d8dee9] bg-white py-0.5 pr-7 pl-2 text-xs text-[#2e3440] dark:border-[#4c566a] dark:bg-[#2e3440] dark:text-[#d8dee9]"
				>
					{#each directories as item (item)}
						<option value={item}>{item || 'Repository root'}</option>
					{/each}
				</select>
			{/if}
			<div class="flex flex-wrap gap-x-3 gap-y-1">
				{#each directoryFiles as file (file)}
					<label class="flex items-center gap-1.5 text-[#2e3440] dark:text-[#d8dee9]">
						<input
							type="checkbox"
							checked={selectedFiles.includes(file)}
							onchange={() => toggleFile(file)}
							class="rounded border-[#4c566a] text-[#5e81ac]"
						/>
						<code>{file}</code>
					</label>
				{/each}
			</div>
		</fieldset>
		<label class="flex min-w-0 flex-col gap-1">
			<span class="font-semibold text-[#4c566a] dark:text-[#d8dee9]/70">Environment file</span>
			<input
				type="text"
				bind:value={envFile}
				spellcheck="false"
				placeholder=".env in the project directory"
				class="rounded border border-[#d8dee9] bg-white px-2 py-1 text-xs text-[#2e3440] dark:border-[#4c566a] dark:bg-[#2e3440] dark:text-[#d8dee9]"
			/>
		</label>
		<label class="flex min-w-0 flex-col gap-1">
			<span class="font-semibold text-[#4c566a] dark:text-[#d8dee9]/70">Profiles</span>
			<input
				type="text"
				bind:value={profilesText}
				spellcheck="false"
				placeholder="None"
				class="rounded border border-[#d8dee9] bg-white px-2 py-1 text-xs text-[#2e3440] dark:border-[#4c566a] dark:bg-[#2e3440] dark:text-[#d8dee9]"
			/>
		</label>
	</div>

	<RequestError message={inspectError} onRetry={() => void inspect()} />
	<RequestError message={actionError} />

	{#if inspection && fresh}
		{#if inspection.ownership === 'other'}
			<p
				role="alert"
				class="mt-2 flex items-start gap-1.5 rounded-lg border border-[#bf616a]/30 bg-[#bf616a]/10 px-3 py-2 text-xs text-[#bf616a]"
			>
				<TriangleAlert size={13} class="mt-0.5 shrink-0" />
				<span>
					Project <strong>{inspection.projectName}</strong> already has containers from
					{inspection.otherWorkingDirs.join(', ')}. Actions are disabled, because Compose would
					change that stack. Stop it from its own repository, or give this sandbox another project
					name.
				</span>
			</p>
		{/if}
		{#each inspection.warnings as warning, index (index)}
			<p class="mt-1 flex items-start gap-1.5 text-xs text-[#d08770]">
				<TriangleAlert size={12} class="mt-0.5 shrink-0" />
				<span class="break-all">{warning}</span>
			</p>
		{/each}

		{#if inspection.services.length === 0}
			<p class="mt-3 text-xs text-[#4c566a] italic dark:text-[#d8dee9]/60">
				No services in the selected files and profiles.
			</p>
		{:else}
			<div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
				<span class="font-semibold text-[#4c566a] dark:text-[#d8dee9]/70">Services</span>
				<span class="text-[#4c566a] dark:text-[#d8dee9]/60"
					>{effective.length} of {serviceNames.length} selected</span
				>
				<button
					type="button"
					onclick={() => selectAllServices(true)}
					disabled={chosen.length === serviceNames.length}
					class="rounded px-1.5 font-medium text-[#5e81ac] hover:bg-[#81a1c1]/10 disabled:opacity-50 dark:text-[#88c0d0]"
				>
					All
				</button>
				<button
					type="button"
					onclick={() => selectAllServices(false)}
					disabled={chosen.length === 0}
					class="rounded px-1.5 font-medium text-[#5e81ac] hover:bg-[#81a1c1]/10 disabled:opacity-50 dark:text-[#88c0d0]"
				>
					None
				</button>
				<span class="text-[#4c566a]/80 dark:text-[#d8dee9]/50"
					>Build and Start use the selection. Other services keep their state.</span
				>
			</div>
			<ul
				class="mt-1.5 divide-y divide-[#d8dee9]/60 rounded-lg border border-[#d8dee9] bg-white text-xs dark:divide-[#4c566a]/60 dark:border-[#4c566a] dark:bg-[#2e3440]"
			>
				{#each inspection.services as service (service.name)}
					{@const status = serviceState(service.name)}
					{@const dependency = implied.includes(service.name)}
					{@const selected = effective.includes(service.name)}
					<li
						class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 {selected
							? ''
							: 'opacity-60'}"
					>
						<label class="flex w-44 min-w-0 items-center gap-1.5">
							<input
								type="checkbox"
								checked={selected}
								disabled={dependency}
								onchange={() => toggleService(service.name)}
								class="rounded border-[#4c566a] text-[#5e81ac] disabled:opacity-50"
							/>
							<span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full {status.tone}"></span>
							<span class="truncate font-medium text-[#2e3440] dark:text-[#eceff4]"
								>{service.name}</span
							>
						</label>
						{#if dependency}
							<span
								class="rounded bg-[#ebcb8b]/15 px-1.5 text-[#d08770]"
								title="A selected service depends on this service">dependency</span
							>
						{/if}
						<span
							class="min-w-0 flex-1 truncate text-[#4c566a] dark:text-[#d8dee9]/60"
							title={service.image}
						>
							{#if service.hasBuild}<span class="text-[#ebcb8b]">build</span
								>{#if service.image}&nbsp;→&nbsp;{/if}{/if}{service.image ?? ''}
						</span>
						{#each service.ports as port, index (index)}
							<span
								class="rounded bg-[#e5e9f0] px-1.5 font-mono text-[#4c566a] dark:bg-[#434c5e] dark:text-[#d8dee9]"
								title={port.hostIp ? `Published on ${port.hostIp}` : undefined}
								>{port.published ? `${port.published}→` : ''}{port.target}{port.protocol === 'tcp'
									? ''
									: `/${port.protocol}`}</span
							>
						{/each}
						<span class="text-[#4c566a] dark:text-[#d8dee9]/60">{status.label}</span>
					</li>
				{/each}
			</ul>
		{/if}

		{#if inspection.networks.length > 0}
			<div class="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
				<Network size={12} class="text-[#4c566a] dark:text-[#d8dee9]/60" />
				{#each inspection.networks as network (network.key)}
					<span
						class="rounded-full border border-[#d8dee9] px-2 py-0.5 text-[#4c566a] dark:border-[#4c566a] dark:text-[#d8dee9]/80"
						title={network.external
							? 'External: Compose expects this network to exist'
							: 'Created by this project'}
						>{network.name}{network.subnet ? ` · ${network.subnet}` : ''}{network.external
							? ' · external'
							: ''}</span
					>
				{/each}
				<span class="text-[#4c566a]/80 dark:text-[#d8dee9]/50"
					>Join from a devcontainer: ⋯ › Connect to network…</span
				>
			</div>
		{/if}
	{/if}

	<div class="mt-3 flex flex-wrap items-center gap-1.5">
		{@render actionButton('build', 'text-[#81a1c1]')}
		{@render actionButton('up', 'text-[#a3be8c]')}
		{@render actionButton('up-build', 'text-[#a3be8c]')}
		{@render actionButton('stop', 'text-[#bf616a]')}
		{#if fresh && runningOutside.length > 0}
			<button
				type="button"
				onclick={() => void start('stop', runningOutside, 'stop-unselected')}
				disabled={blocked}
				class="flex items-center gap-1 rounded-lg border border-[#d8dee9] bg-white px-2.5 py-1 text-xs font-medium text-[#bf616a] transition-colors hover:bg-[#e5e9f0] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#4c566a] dark:bg-[#2e3440] dark:hover:bg-[#434c5e]"
				title={`Stop ${runningOutside.join(', ')}`}
			>
				{#if starting === 'stop-unselected'}
					<Loader size={12} class="animate-spin" />
				{:else}
					<Square size={12} />
				{/if}
				Stop unselected ({runningOutside.length})
			</button>
		{/if}
		<button
			type="button"
			onclick={openLogs}
			disabled={!fresh || !inspection?.containers.length}
			class="flex items-center gap-1 rounded-lg border border-[#d8dee9] bg-white px-2.5 py-1 text-xs font-medium text-[#4c566a] transition-colors hover:bg-[#e5e9f0] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#4c566a] dark:bg-[#2e3440] dark:text-[#d8dee9] dark:hover:bg-[#434c5e]"
			title="Follow logs of the selected services in a terminal"
		>
			<ScrollText size={12} />
			Service logs
		</button>
		{#if commandPreview}
			<details class="ml-auto min-w-0 text-xs">
				<summary class="cursor-pointer text-[#4c566a] dark:text-[#d8dee9]/60">Docker calls</summary>
				<pre
					class="mt-1 max-w-full overflow-x-auto rounded bg-[#2e3440] p-2 font-mono text-[11px] text-[#d8dee9]">{commandPreview}</pre>
			</details>
		{/if}
	</div>

	{#if run}
		{@const activeRun = run}
		<div
			class="mt-3 overflow-hidden rounded-lg border border-[#d8dee9] dark:border-[#4c566a]"
			aria-live="polite"
		>
			<div class="flex items-center gap-2 bg-white px-3 py-1.5 text-xs dark:bg-[#2e3440]">
				{#if activeRun.status === 'running'}
					<Loader size={12} class="animate-spin text-[#ebcb8b]" />
					<span class="font-medium text-[#ebcb8b]">{runLabel(activeRun)} running…</span>
					<button
						type="button"
						onclick={() => void removeRun(activeRun.id)}
						class="ml-auto flex items-center gap-1 rounded-lg px-2 py-0.5 font-medium text-[#bf616a] hover:bg-[#bf616a]/10"
						title="Stop the Compose process. Resources that Compose already created stay."
					>
						<X size={12} />
						Cancel
					</button>
				{:else if activeRun.status === 'failed'}
					<TriangleAlert size={12} class="text-[#bf616a]" />
					<span class="font-medium text-[#bf616a]">{runLabel(activeRun)} failed</span>
					{#if activeRun.hasLog}
						<button
							type="button"
							onclick={() => onOpenLog(activeRun.id, `${repo.name} ${runLabel(activeRun)} log`)}
							class="ml-auto flex items-center gap-1 rounded-lg px-2 py-0.5 font-medium text-[#81a1c1] hover:bg-[#81a1c1]/10"
						>
							<FileText size={12} />
							View log
						</button>
					{/if}
					<button
						type="button"
						onclick={() => void removeRun(activeRun.id)}
						class="{activeRun.hasLog
							? ''
							: 'ml-auto'} flex items-center gap-1 rounded-lg px-2 py-0.5 font-medium text-[#bf616a] hover:bg-[#bf616a]/10"
						title="Dismiss and delete the log"
					>
						<X size={12} />
						Dismiss
					</button>
				{:else}
					<span class="font-medium text-[#a3be8c]">{runLabel(activeRun)} finished</span>
					<button
						type="button"
						onclick={() => void removeRun(activeRun.id)}
						class="ml-auto flex items-center gap-1 rounded-lg px-2 py-0.5 font-medium text-[#4c566a] hover:bg-[#d8dee9]/60 dark:text-[#d8dee9]/70 dark:hover:bg-[#4c566a]"
					>
						<X size={12} />
						Dismiss
					</button>
				{/if}
			</div>
			{#if activeRun.status === 'running'}
				<!-- Output while the process runs; the process continues if this view closes -->
				<div class="h-64 overflow-hidden border-t border-[#d8dee9] dark:border-[#4c566a]">
					<TerminalTab sessionId={activeRun.id} active={true} onExit={runExited} />
				</div>
			{/if}
		</div>
	{/if}
</div>
