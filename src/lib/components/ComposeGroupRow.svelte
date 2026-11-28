<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		ChevronRight,
		ChevronDown,
		Play,
		Square,
		RotateCw,
		Loader2,
		Network,
		Globe,
		Trash2
	} from 'lucide-svelte';
	import { errorMessage, latestRequest, requestJson } from '$lib/requests';
	import RequestError from './RequestError.svelte';
	import type { ContainerData, NetworkData, ServiceAccess, ServicePortPolicy } from '$lib/types';
	import { containerExposure } from '$lib/publishedPorts';
	import SandboxRow from './SandboxRow.svelte';
	import ComposeNetworks from './ComposeNetworks.svelte';
	import SandboxVersionChip from './SandboxVersionChip.svelte';
	import StackKindChips from './stack/StackKindChips.svelte';
	import ProfileGroups from './stack/ProfileGroups.svelte';
	import InstanceRemoveDialog from './stack/InstanceRemoveDialog.svelte';
	import { presenterFor, stackPresentation } from './stack/presenters';
	import type { StackView } from './stack/types';

	import SandboxRemoveDialog from './SandboxRemoveDialog.svelte';

	interface Props {
		projectName: string;
		containers: ContainerData[];
		vscodeSshHost: string;
		serviceProxyEnabled?: boolean;
		/** Which container ports are web services, and how the dashboard opens them */
		servicePorts?: ServicePortPolicy;
		serviceAccess?: ServiceAccess;
		onRefresh: () => Promise<void>;
		onOpenTerminal?: (id: string, command: string, name: string, cwd: string) => void;
		/** Networks that the project created or has containers on */
		networks?: NetworkData[];
		/** Devcontainers that can join those networks */
		devcontainers?: ContainerData[];
		/** Open the network drawer; without it, the group shows no network panel */
		onConnectNetwork?: (container: ContainerData, network?: string, seatIp?: string) => void;
	}

	let {
		projectName,
		containers,
		vscodeSshHost,
		serviceProxyEnabled,
		servicePorts = {},
		serviceAccess = 'direct',
		onRefresh,
		onOpenTerminal,
		networks = [],
		devcontainers = [],
		onConnectNetwork
	}: Props = $props();

	let showNetworks = $state(false);
	let expanded = $state(false);
	/** Presenter data for this project; null until loaded or when DevHarbour does not know the source. */
	let view = $state<StackView | null>(null);
	const viewReads = latestRequest();
	const presenter = $derived(
		presenterFor(view?.kind.presenter ?? stackPresentation(containers).presenter.id)
	);

	/** Load kind metadata for the presenter; a failure keeps the generic presenter. */
	async function loadView(project: string) {
		try {
			await viewReads.run(
				(signal) =>
					requestJson<StackView>(`/api/compose/stack?project=${encodeURIComponent(project)}`, {
						signal
					}),
				(value) => (view = value)
			);
		} catch {
			view = null;
		}
	}

	$effect(() => {
		void loadView(projectName);
		return () => viewReads.cancel();
	});
	let removing = $state(false);
	let loadingAction = $state<string | null>(null);
	let actionError = $state('');
	let actionSummary = $state('');
	let disposed = false;
	onDestroy(() => {
		disposed = true;
	});

	const runningCount = $derived(containers.filter((c) => c.state === 'running').length);
	const totalCount = $derived(containers.length);
	const anyRunning = $derived(runningCount > 0);
	/** Live image data for the version chip. */
	const versionContainers = $derived(
		containers.map((c) => ({ image: c.image, service: c.composeService, sandboxTag: c.sandboxTag }))
	);
	/** One exposure warning for the group, instead of one under every container. */
	const exposedCount = $derived(
		containers.filter((c) => containerExposure(c.portBindings) === 'all').length
	);

	async function handleGroupAction(action: 'start' | 'stop' | 'restart') {
		if (loadingAction) return;
		loadingAction = action;
		actionError = '';
		actionSummary = '';
		try {
			const targets = containers.filter((c) =>
				action === 'start' ? c.state !== 'running' : c.state === 'running'
			);
			const results = await Promise.allSettled(
				targets.map((c) => requestJson(`/api/containers/${c.id}/${action}`, { method: 'POST' }))
			);
			if (disposed) return;
			const failures = results.flatMap((result, index) =>
				result.status === 'rejected'
					? [`${targets[index].name.replace(/^\//, '')}: ${errorMessage(result.reason)}`]
					: []
			);
			actionSummary = `${action}: ${targets.length - failures.length} of ${targets.length} succeeded.`;
			actionError = failures.join(' ');
			try {
				await onRefresh();
			} catch (cause) {
				if (!disposed) actionError += ` Status may be outdated. ${errorMessage(cause)}`;
			}
		} catch (cause) {
			if (!disposed) actionError = errorMessage(cause);
		} finally {
			if (!disposed) loadingAction = null;
		}
	}
</script>

{#snippet containerRow(container: ContainerData)}
	<div>
		<SandboxRow
			{container}
			{vscodeSshHost}
			{serviceProxyEnabled}
			{servicePorts}
			{serviceAccess}
			{onRefresh}
			{onOpenTerminal}
		/>
		{#if presenter.Row && view}
			{@const Row = presenter.Row}
			<Row {view} {container} />
		{/if}
	</div>
{/snippet}

<div>
	{#if actionSummary}<p role="status" class="px-5 text-xs">{actionSummary}</p>{/if}
	<div class="px-5"><RequestError message={actionError} /></div>
	<!-- Summary row -->
	<div
		class="flex items-center justify-between gap-4 px-5 py-3 transition-colors
			{anyRunning
			? 'hover:bg-[#eceff4]/50 dark:hover:bg-[#434c5e]/50'
			: 'bg-[#e5e9f0]/50 opacity-80 hover:bg-[#e5e9f0] dark:bg-[#2e3440]/30 dark:hover:bg-[#2e3440]/50'}"
	>
		<button
			class="flex min-w-0 flex-grow cursor-pointer flex-wrap items-center gap-2 border-none bg-transparent p-0 text-left"
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
		>
			<!-- Expand/collapse icon -->
			<span class="shrink-0 text-[#4c566a] dark:text-[#d8dee9]/60">
				{#if expanded}
					<ChevronDown size={16} />
				{:else}
					<ChevronRight size={16} />
				{/if}
			</span>

			<!-- Status dot -->
			<div
				class="h-2 w-2 shrink-0 rounded-full {anyRunning ? 'bg-[#a3be8c]' : 'bg-[#4c566a]'}"
			></div>

			<!-- Project name -->
			<h4
				class="min-w-0 text-sm font-bold [overflow-wrap:anywhere]
					{anyRunning ? 'text-[#2e3440] dark:text-[#eceff4]' : 'text-[#4c566a] dark:text-[#d8dee9]/70'}"
			>
				{projectName}
			</h4>

			<SandboxVersionChip project={projectName} containers={versionContainers} />
			<StackKindChips {containers} {view} />
		</button>

		<!-- Group actions -->
		<div
			class="flex shrink-0 items-center gap-1.5 rounded-xl border border-[#d8dee9] bg-[#eceff4] p-1 shadow-sm dark:border-[#434c5e] dark:bg-[#2e3440]"
			role="group"
		>
			{#if anyRunning}
				<button
					class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#ebcb8b] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#ebcb8b]"
					disabled={loadingAction !== null}
					onclick={() => handleGroupAction('restart')}
					title="Restart all"
				>
					{#if loadingAction === 'restart'}
						<Loader2 size={16} class="animate-spin" />
					{:else}
						<RotateCw size={16} />
					{/if}
				</button>
				<button
					class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#bf616a] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#bf616a]"
					disabled={loadingAction !== null}
					onclick={() => handleGroupAction('stop')}
					title="Stop all"
				>
					{#if loadingAction === 'stop'}
						<Loader2 size={16} class="animate-spin" />
					{:else}
						<Square size={16} class="fill-current" />
					{/if}
				</button>
			{:else}
				<button
					class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#a3be8c] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#a3be8c]"
					disabled={loadingAction !== null}
					onclick={() => handleGroupAction('start')}
					title="Start all"
				>
					{#if loadingAction === 'start'}
						<Loader2 size={16} class="animate-spin" />
					{:else}
						<Play size={16} class="fill-current" />
					{/if}
				</button>
			{/if}
			<button
				class="rounded-lg p-1.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#bf616a] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#3b4252] dark:hover:text-[#bf616a]"
				disabled={loadingAction !== null}
				onclick={() => (removing = true)}
				title={view?.instance ? 'Remove instance…' : 'Remove sandbox…'}
				aria-label={`${view?.instance ? 'Remove instance' : 'Remove sandbox'} ${projectName}`}
			>
				<Trash2 size={16} />
			</button>
		</div>
	</div>

	<div class="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 pb-3">
		<!-- Running count badge -->
		<span
			class="rounded-full px-2 py-0.5 text-xs font-medium
					{anyRunning
				? 'border border-[#a3be8c]/20 bg-[#a3be8c]/15 text-[#a3be8c]'
				: 'border border-[#4c566a]/20 bg-[#4c566a]/10 text-[#4c566a] dark:text-[#d8dee9]/50'}"
		>
			{runningCount}/{totalCount} running
		</span>

		{#if exposedCount > 0}
			<span
				class="inline-flex items-center gap-1.5 rounded-full border border-[#b48ead]/40 bg-[#b48ead]/10 px-2 py-0.5 text-xs font-medium text-[#b48ead]"
				title={`${exposedCount} of ${totalCount} containers publish ports on all host interfaces`}
			>
				<Globe size={12} />
				{exposedCount} on all interfaces
			</span>
		{/if}

		{#if networks.length > 0}
			{#if presenter.id === 'profile' && onConnectNetwork}
				<button
					type="button"
					aria-expanded={showNetworks}
					onclick={() => (showNetworks = !showNetworks)}
					class="inline-flex items-center gap-1.5 rounded px-1 text-xs text-[#4f8584] hover:underline dark:text-[#8fbcbb]"
				>
					<Network size={14} />
					{networks.length}
					{networks.length === 1 ? 'network' : 'networks'}
				</button>
			{:else}
				<span
					class="inline-flex items-center gap-1.5 text-xs text-[#4f8584] dark:text-[#8fbcbb]"
					title={networks.map((network) => network.name).join(', ')}
				>
					<Network size={14} />
					{networks.length}
					{networks.length === 1 ? 'network' : 'networks'}
				</span>
			{/if}
		{/if}
	</div>
	{#if presenter.Actions && view?.kind.actions?.length}
		{@const Actions = presenter.Actions}
		<div class="border-t border-[#d8dee9]/70 px-5 py-3 dark:border-[#4c566a]/70">
			{#key view.project}
				<Actions {view} {containers} onChanged={() => void loadView(projectName)} />
			{/key}
		</div>
	{/if}

	{#if removing && view?.instance}
		<InstanceRemoveDialog
			project={projectName}
			onClose={() => (removing = false)}
			onRemoved={() => void onRefresh().catch(() => {})}
		/>
	{:else if removing}
		<SandboxRemoveDialog
			project={projectName}
			onClose={() => (removing = false)}
			onRemoved={() => void onRefresh().catch(() => {})}
		/>
	{/if}

	{#if presenter.id === 'profile' && showNetworks && networks.length > 0 && onConnectNetwork}
		<ComposeNetworks {projectName} {networks} {devcontainers} {onConnectNetwork} />
	{/if}

	<!-- Expanded container list -->
	{#if expanded}
		<div class="bg-[#f0f4f8] dark:bg-[#2e3440]">
			{#if presenter.id !== 'profile' && networks.length > 0 && onConnectNetwork}
				<ComposeNetworks {projectName} {networks} {devcontainers} {onConnectNetwork} />
			{/if}
			{#if view}
				{#each presenter.panels as Panel, index (index)}
					<Panel {view} {containers} onChanged={() => void loadView(projectName)} />
				{/each}
			{/if}
			{#if presenter.id === 'profile' && view}
				<ProfileGroups {view} {containers} row={containerRow} />
			{:else}
				<div class="divide-y divide-[#d8dee9]/60 dark:divide-[#4c566a]/60">
					{#each containers as container (container.id)}
						{@render containerRow(container)}
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>
