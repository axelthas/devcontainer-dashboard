<script lang="ts">
	/** Workspaces on this host, and Dev Bootstrap, which creates new ones. */
	import { Package, Plus } from 'lucide-svelte';
	import { resolve } from '$app/paths';
	import { useMobileDashboard, workspaceKey } from '$lib/mobile/dashboard.svelte';
	import MBanner from '$lib/components/mobile/MBanner.svelte';
	import MDot from '$lib/components/mobile/MDot.svelte';
	import MGroup from '$lib/components/mobile/MGroup.svelte';
	import MIconButton from '$lib/components/mobile/MIconButton.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';
	import MNewWorkspaceSheet from '$lib/components/mobile/MNewWorkspaceSheet.svelte';
	import MRow from '$lib/components/mobile/MRow.svelte';
	import MSearch from '$lib/components/mobile/MSearch.svelte';
	import { TriangleAlert } from 'lucide-svelte';

	const dashboard = useMobileDashboard();
	let creating = $state(false);
	let query = $state(dashboard.ui.workspaceQuery ?? '');
	$effect(() => {
		dashboard.ui.workspaceQuery = query;
	});

	/** Workspace names match, or any repository name in them. */
	const list = $derived(
		dashboard.workspaces.filter((workspace) => {
			const needle = query.trim().toLowerCase();
			if (!needle) return true;
			return (
				workspace.name.toLowerCase().includes(needle) ||
				workspace.repos.some((repo) => repo.name.toLowerCase().includes(needle))
			);
		})
	);

	/** Break long dotted names at their separators instead of mid-word. */
	function breakable(name: string): string {
		return name.replace(/([./_-])/g, '$1\u200b');
	}
</script>

<MNavBar title="Workspaces">
	{#snippet right()}
		<MIconButton
			icon={Plus}
			label="New workspace"
			onclick={() => (creating = true)}
			testid="new-workspace"
		/>
	{/snippet}
</MNavBar>
<MSearch bind:value={query} placeholder="Search workspaces and repos" />
{#if dashboard.workspaceError}
	<MBanner
		icon={TriangleAlert}
		tone="bg-m-stop/15 text-m-stop"
		title="Workspace status may be outdated"
		detail={dashboard.workspaceError}
		action="Retry"
		onAction={() => void dashboard.refreshWorkspaces().catch(() => {})}
	/>
{/if}
<MGroup>
	<MRow
		title="Dev Bootstrap"
		subtitle="Version, updates and new workspaces"
		tone="bg-m-brain/15 text-m-brain"
		href={resolve('/mobile/workspaces/bootstrap')}
	>
		{#snippet icon()}<Package size={18} />{/snippet}
	</MRow>
</MGroup>
{#if list.length === 0}
	<p class="px-8 py-8 text-center text-[15px] text-m-dim">
		{query ? 'No workspace matches the search.' : `No workspaces in ${dashboard.workspaceRoot}.`}
	</p>
{:else}
	<MGroup title="On this host">
		{#each list as workspace (workspace.id)}
			{@const running = workspace.repos.filter((repo) => repo.isRunning).length}
			{@const busy =
				workspace.buildSession?.status === 'running' ||
				workspace.repos.some(
					(repo) => repo.buildSession?.status === 'running' || repo.composeRun?.status === 'running'
				)}
			<MRow
				href={resolve('/mobile/workspaces/[workspace]', { workspace: workspaceKey(workspace) })}
				subtitle={[
					`${workspace.repos.length} ${workspace.repos.length === 1 ? 'repo' : 'repos'}`,
					workspace.solutionMetadata?.solution,
					running ? `${running} running` : null
				]
					.filter(Boolean)
					.join(' · ')}
				testid="workspace-row"
			>
				{#snippet title()}<span class="font-semibold">{breakable(workspace.name)}</span>{/snippet}
				{#snippet trailing()}
					{#if busy || running}<MDot state="running" {busy} />{/if}
				{/snippet}
			</MRow>
		{/each}
	</MGroup>
{/if}

<MNewWorkspaceSheet open={creating} onClose={() => (creating = false)} manageLink />
