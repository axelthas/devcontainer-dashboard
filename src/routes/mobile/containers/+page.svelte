<script lang="ts">
	/** Devcontainers, running first. Compose services live under Services. */
	import { BrainCircuit, Plus, WifiOff } from 'lucide-svelte';
	import { resolve } from '$app/paths';
	import { useBrainAccess } from '$lib/brainAccess.svelte';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';
	import MBanner from '$lib/components/mobile/MBanner.svelte';
	import MChip from '$lib/components/mobile/MChip.svelte';
	import MDot from '$lib/components/mobile/MDot.svelte';
	import MGroup from '$lib/components/mobile/MGroup.svelte';
	import MIconButton from '$lib/components/mobile/MIconButton.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';
	import MNewShellSheet from '$lib/components/mobile/MNewShellSheet.svelte';
	import MRow from '$lib/components/mobile/MRow.svelte';
	import MSearch from '$lib/components/mobile/MSearch.svelte';
	import MSegmented from '$lib/components/mobile/MSegmented.svelte';

	const dashboard = useMobileDashboard();
	const brain = useBrainAccess();
	type Filter = 'running' | 'stopped' | 'all';
	let query = $state(dashboard.ui.containerQuery ?? '');
	const filter = $derived((dashboard.ui.containerFilter as Filter | undefined) ?? 'running');
	$effect(() => {
		dashboard.ui.containerQuery = query;
	});

	const running = $derived(dashboard.devcontainers.filter((c) => c.state === 'running'));
	const list = $derived(
		dashboard.devcontainers.filter((c) => {
			if (filter === 'running' && c.state !== 'running') return false;
			if (filter === 'stopped' && c.state === 'running') return false;
			const needle = query.trim().toLowerCase();
			return !needle || `${c.projectName} ${c.name}`.toLowerCase().includes(needle);
		})
	);
	const readAt = $derived(
		dashboard.lastContainerRead ? ` from ${dashboard.lastContainerRead}` : ''
	);
</script>

<MNavBar title="Containers">
	{#snippet right()}
		<MIconButton
			icon={Plus}
			label="New shell"
			onclick={() => (dashboard.newShellOpen = true)}
			testid="new-shell"
		/>
	{/snippet}
</MNavBar>
<MSearch bind:value={query} placeholder="Search containers" />
<MSegmented
	label="Show"
	value={filter}
	onChange={(value) => (dashboard.ui.containerFilter = value)}
	options={[
		{ value: 'running', label: `Running ${running.length}` },
		{ value: 'stopped', label: `Stopped ${dashboard.devcontainers.length - running.length}` },
		{ value: 'all', label: 'All' }
	]}
/>
{#if dashboard.containerError}
	<MBanner
		icon={WifiOff}
		tone="bg-m-stop/15 text-m-stop"
		title="Docker is not answering"
		detail={`Showing the last list${readAt}. ${dashboard.containerError}`}
		action="Retry"
		onAction={() => void dashboard.refreshContainers().catch(() => {})}
	/>
{/if}
{#if list.length === 0}
	<p class="px-8 py-10 text-center text-[15px] text-m-dim" data-testid="containers-empty">
		{query
			? 'No container matches the search.'
			: filter === 'running'
				? 'No devcontainer runs.'
				: 'No devcontainers.'}
	</p>
{:else}
	<MGroup
		footer={filter === 'running'
			? 'Devcontainers only. Compose stacks and other Docker services are under Services.'
			: undefined}
	>
		{#each list as container (container.id)}
			{@const grant = brain?.grantFor(container.id)}
			{@const ports = Object.keys(container.ports).length}
			<MRow
				href={resolve('/mobile/containers/[id]', { id: container.id })}
				tone="bg-transparent"
				testid="container-row"
			>
				{#snippet icon()}<MDot state={container.state} />{/snippet}
				{#snippet title()}<span class="font-semibold">{container.projectName}</span>{/snippet}
				{#snippet subtitle()}<span class="font-mono text-[13px]"
						>{container.name.replace(/^\//, '')}</span
					>{/snippet}
				{#snippet trailing()}
					{#if grant}
						<MChip tone="border-m-brain/50 text-m-brain"><BrainCircuit size={13} />Brain</MChip>
					{:else if container.state !== 'running'}
						<span class="shrink-0 text-[14px] text-m-dim">Stopped</span>
					{:else if ports}
						<span class="shrink-0 text-[14px] text-m-dim"
							>{ports} {ports === 1 ? 'port' : 'ports'}</span
						>
					{/if}
				{/snippet}
			</MRow>
		{/each}
	</MGroup>
{/if}
<MNewShellSheet />
