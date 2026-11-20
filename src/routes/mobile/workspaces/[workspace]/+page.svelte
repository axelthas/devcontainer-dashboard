<script lang="ts">
	/** One workspace: its repositories, with search and a state filter. */
	import {
		Code,
		Copy,
		FileText,
		GitBranch,
		Loader2,
		RotateCw,
		SquareTerminal,
		Tag,
		Trash2,
		X
	} from 'lucide-svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { requestJson, errorMessage } from '$lib/requests';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';
	import { shellQuote } from '$lib/shell';
	import type { RepositoryData } from '$lib/types';
	import MBanner from '$lib/components/mobile/MBanner.svelte';
	import MChip from '$lib/components/mobile/MChip.svelte';
	import MConfirm from '$lib/components/mobile/MConfirm.svelte';
	import MDot from '$lib/components/mobile/MDot.svelte';
	import MGroup from '$lib/components/mobile/MGroup.svelte';
	import MIconButton from '$lib/components/mobile/MIconButton.svelte';
	import MLogSheet from '$lib/components/mobile/MLogSheet.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';
	import MRow from '$lib/components/mobile/MRow.svelte';
	import MSearch from '$lib/components/mobile/MSearch.svelte';
	import MSegmented from '$lib/components/mobile/MSegmented.svelte';
	import MSheet from '$lib/components/mobile/MSheet.svelte';

	const dashboard = useMobileDashboard();
	const key = $derived(page.params.workspace ?? '');
	const workspace = $derived(dashboard.workspace(key));
	type Filter = 'all' | 'running' | 'devcontainer';
	let filter = $state<Filter>('all');
	let query = $state('');
	let sheet = $state<'actions' | 'delete' | null>(null);
	let logOpen = $state(false);
	let deleting = $state(false);
	let error = $state('');

	const list = $derived(
		(workspace?.repos ?? []).filter((repo) => {
			if (filter === 'running' && !repo.isRunning) return false;
			if (filter === 'devcontainer' && !repo.hasDevcontainer) return false;
			const needle = query.trim().toLowerCase();
			return !needle || repo.name.toLowerCase().includes(needle);
		})
	);
	const bootstrap = $derived(workspace?.buildSession);

	/** Break long dotted names at their separators instead of mid-word. */
	function breakable(name: string): string {
		return name.replace(/([./_-])/g, '$1\u200b');
	}

	/** The checked-out branch, or the tag for a detached HEAD. */
	function ref(repo: RepositoryData): { label: string; tag: boolean } | null {
		if (repo.currentTag) return { label: repo.currentTag, tag: true };
		if (repo.currentBranch) return { label: repo.currentBranch, tag: false };
		return null;
	}

	/** Open a terminal for a command in the workspace folder, then show it. */
	function terminal(name: string, command: string, kind: 'shell' | 'bootstrap' = 'shell') {
		if (!workspace) return;
		sheet = null;
		const id = dashboard.openTerminal({ name, command, cwd: workspace.path, kind });
		void goto(dashboard.terminalHref(id));
	}

	async function copyVscode() {
		if (!workspace) return;
		const host = dashboard.vscodeSshHost;
		const link = host
			? `vscode://vscode-remote/ssh-remote+${host}${workspace.path}?windowId=_blank`
			: `vscode://file${workspace.path}?windowId=_blank`;
		sheet = null;
		try {
			await navigator.clipboard.writeText(link);
			dashboard.toast('Copied the VS Code link');
		} catch {
			dashboard.toast(`Copy failed: ${link}`);
		}
	}

	/** Delete the folder after the sheet confirmation; the server checks the path again. */
	async function deleteWorkspace() {
		if (!workspace || deleting) return;
		deleting = true;
		error = '';
		try {
			await requestJson('/api/workspaces', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: workspace.path })
			});
			sheet = null;
			dashboard.toast('Workspace deleted');
			await goto(resolve('/mobile/workspaces'));
			await dashboard.refreshWorkspaces().catch(() => {});
		} catch (cause) {
			error = errorMessage(cause);
		} finally {
			deleting = false;
		}
	}

	/** Cancel a running bootstrap run, or dismiss a failed one and delete its log. */
	async function dismissBootstrap(id: string) {
		try {
			await requestJson('/api/bootstrap/run', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id })
			});
			await dashboard.refreshWorkspaces();
		} catch (cause) {
			dashboard.toast(errorMessage(cause));
		}
	}
</script>

<MNavBar back={{ href: resolve('/mobile/workspaces'), label: 'Workspaces' }}>
	{#snippet right()}
		{#if workspace}
			<MIconButton
				label="Workspace actions"
				onclick={() => (sheet = 'actions')}
				testid="workspace-actions"
			/>
		{/if}
	{/snippet}
</MNavBar>

{#if !workspace}
	<p class="px-8 py-12 text-center text-[16px] text-m-dim">This workspace no longer exists.</p>
{:else}
	<div class="px-5 pb-4">
		<h2 class="text-[26px] leading-tight font-bold [overflow-wrap:anywhere]">
			{breakable(workspace.name)}
		</h2>
		<div class="mt-2 flex flex-wrap gap-1.5">
			<MChip>{workspace.repos.length} repos</MChip>
			{#if workspace.solutionMetadata?.solution}
				<MChip tone="border-m-glacier/50 text-m-glacier"
					>{workspace.solutionMetadata.solution}</MChip
				>
			{/if}
			{#if workspace.solutionMetadata?.tag}
				<MChip tone="border-m-run/50 text-m-run">{workspace.solutionMetadata.tag}</MChip>
			{/if}
			{#if workspace.solutionMetadata?.bootstrap_version}
				<MChip tone="border-m-brain/50 text-m-brain"
					>bootstrap {workspace.solutionMetadata.bootstrap_version}</MChip
				>
			{/if}
		</div>
	</div>

	{#if bootstrap?.status === 'running'}
		<MGroup title="Bootstrap" footer="The run continues on the host if you leave this screen.">
			<MRow
				title="Bootstrap is running"
				subtitle="Open its terminal"
				tone="bg-m-brain/15 text-m-brain"
				href={dashboard.terminalHref(bootstrap.id)}
			>
				{#snippet icon()}<Loader2 size={18} class="animate-spin" />{/snippet}
			</MRow>
			<MRow
				title="Cancel run"
				danger
				tone="bg-m-stop/15 text-m-stop"
				onclick={() => void dismissBootstrap(bootstrap.id)}
			>
				{#snippet icon()}<X size={18} />{/snippet}
			</MRow>
		</MGroup>
	{:else if bootstrap?.status === 'failed'}
		<MBanner
			icon={X}
			tone="bg-m-stop/15 text-m-stop"
			title="Bootstrap failed"
			detail={bootstrap.hasLog ? 'The output is kept as a log.' : undefined}
			action="Dismiss"
			onAction={() => void dismissBootstrap(bootstrap.id)}
		/>
		{#if bootstrap.hasLog}
			<MGroup>
				<MRow title="View log" onclick={() => (logOpen = true)}>
					{#snippet icon()}<FileText size={18} />{/snippet}
				</MRow>
			</MGroup>
		{/if}
	{/if}

	<MSearch bind:value={query} placeholder={`Search ${workspace.repos.length} repos`} />
	<MSegmented
		label="Show"
		value={filter}
		onChange={(value) => (filter = value)}
		options={[
			{ value: 'all', label: 'All' },
			{ value: 'running', label: 'Running' },
			{ value: 'devcontainer', label: 'Devcontainer' }
		]}
	/>
	{#if list.length === 0}
		<p class="px-8 py-8 text-center text-[15px] text-m-dim">No repository matches.</p>
	{:else}
		<MGroup>
			{#each list as repo (repo.path)}
				{@const current = ref(repo)}
				{@const container = dashboard.repoContainer(repo)}
				{@const busy =
					repo.buildSession?.status === 'running' || repo.composeRun?.status === 'running'}
				<MRow
					title={breakable(repo.name)}
					href={resolve('/mobile/workspaces/[workspace]/[repo]', {
						workspace: key,
						repo: repo.name
					})}
					tone="bg-transparent text-m-glacier"
					testid="repo-row"
				>
					{#snippet icon()}
						{#if current?.tag}<Tag size={17} />{:else}<GitBranch size={17} />{/if}
					{/snippet}
					{#snippet subtitle()}<span class="font-mono text-[13px]"
							>{current?.label ?? 'No branch'}</span
						>{/snippet}
					{#snippet trailing()}
						{#if busy}
							<span class="flex shrink-0 items-center gap-1.5 text-[14px] text-m-warn"
								><MDot state="running" busy />Busy</span
							>
						{:else if container?.state === 'running'}
							<span class="flex shrink-0 items-center gap-1.5 text-[14px] text-m-run"
								><MDot state="running" />Running</span
							>
						{:else if container}
							<span class="shrink-0 text-[14px] text-m-dim">Stopped</span>
						{/if}
					{/snippet}
				</MRow>
			{/each}
		</MGroup>
	{/if}

	<MSheet open={sheet === 'actions'} title="Workspace" onClose={() => (sheet = null)}>
		<MGroup>
			<MRow title="Terminal in this folder" onclick={() => terminal(workspace.name, '')} chevron>
				{#snippet icon()}<SquareTerminal size={18} />{/snippet}
			</MRow>
			<MRow
				title="Copy VS Code link"
				tone="bg-m-glacier/15 text-m-glacier"
				onclick={() => void copyVscode()}
			>
				{#snippet icon()}<Code size={18} />{/snippet}
				{#snippet trailing()}<Copy size={17} class="shrink-0 text-m-frost" />{/snippet}
			</MRow>
		</MGroup>
		<MGroup>
			<MRow
				title="Rerun bootstrap"
				subtitle="Opens devbootstrap --rerun in a terminal"
				tone="bg-m-brain/15 text-m-brain"
				onclick={() =>
					terminal(
						`Rerun ${workspace.name}`,
						`devbootstrap --rerun -d ${shellQuote(workspace.path)}`,
						'bootstrap'
					)}
				chevron
			>
				{#snippet icon()}<RotateCw size={18} />{/snippet}
			</MRow>
		</MGroup>
		<MGroup>
			<MRow
				title="Delete workspace…"
				danger
				tone="bg-m-stop/15 text-m-stop"
				onclick={() => (sheet = 'delete')}
				chevron
			>
				{#snippet icon()}<Trash2 size={18} />{/snippet}
			</MRow>
		</MGroup>
	</MSheet>

	<MSheet open={sheet === 'delete'} title="Delete workspace" onClose={() => (sheet = null)}>
		<MConfirm
			title={`Delete ${workspace.name}?`}
			body={`The folder ${workspace.path} and its ${workspace.repos.length} repositories are deleted from the host, including uncommitted and unpushed work. This cannot be undone.`}
			action={`Delete ${workspace.repos.length} repositories`}
			busy={deleting}
			{error}
			onConfirm={() => void deleteWorkspace()}
			onCancel={() => (sheet = null)}
		/>
	</MSheet>

	{#if bootstrap?.hasLog}
		<MLogSheet
			open={logOpen}
			logId={bootstrap.id}
			title={`${workspace.name} bootstrap log`}
			onClose={() => (logOpen = false)}
		/>
	{/if}
{/if}
