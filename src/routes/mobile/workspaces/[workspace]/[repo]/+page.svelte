<script lang="ts">
	/**
	 * One repository: the checked-out ref, its devcontainer (build, start, or open), and its
	 * Compose sandbox. Each state shows one main action; the rest is one level down.
	 */
	import {
		ArrowUpRight,
		Bot,
		Boxes,
		Check,
		Code,
		Copy,
		GitBranch,
		Globe,
		Hammer,
		Loader2,
		Play,
		SquareTerminal,
		Tag,
		TriangleAlert,
		X
	} from 'lucide-svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { containerOpenCodeCommand, containerShellCommand } from '$lib/containerOpenTargets';
	import { generateId } from '$lib/index';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';
	import { configDisplayName, saveConfig, savedConfig } from '$lib/mobile/devcontainerConfig';
	import { COMPOSE_ACTION_LABELS } from '$lib/composeCommands';
	import { errorMessage, RequestError, requestJson } from '$lib/requests';
	import { openMobileService } from '$lib/mobile/serviceOpen';
	import { buildContainerVscodeUri } from '$lib/vscode';
	import MBanner from '$lib/components/mobile/MBanner.svelte';
	import MButton from '$lib/components/mobile/MButton.svelte';
	import MConfirm from '$lib/components/mobile/MConfirm.svelte';
	import MCopyRow from '$lib/components/mobile/MCopyRow.svelte';
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
	const repo = $derived(workspace?.repos.find((r) => r.name === page.params.repo));
	const container = $derived(repo ? dashboard.repoContainer(repo) : undefined);
	const running = $derived(container?.state === 'running');
	const build = $derived(repo?.buildSession);
	const composeFiles = $derived(repo?.composeFiles ?? []);
	const run = $derived(repo?.composeRun);

	/** The operator's choice on this screen, else the choice saved for the repository. */
	let chosenConfig = $state<string | undefined>(undefined);
	const config = $derived(
		repo && chosenConfig && repo.devcontainerConfigs.includes(chosenConfig)
			? chosenConfig
			: repo
				? savedConfig(repo.path, repo.devcontainerConfigs)
				: undefined
	);

	type Sheet = 'ref' | 'force' | 'open' | null;
	let sheet = $state<Sheet>(null);
	let logOpen = $state(false);
	let busy = $state<'build' | 'start' | 'cancel' | 'checkout' | null>(null);
	let error = $state('');

	// Branches and tags for the ref sheet, read when it opens.
	let refs = $state<{ branches: string[]; tags: string[] } | null>(null);
	let refsError = $state('');
	let refQuery = $state('');
	let pendingRef = $state<{ branch?: string; tag?: string } | null>(null);
	const REF_LIMIT = 60;
	const filteredRefs = $derived.by(() => {
		const needle = refQuery.trim().toLowerCase();
		const match = (name: string) => !needle || name.toLowerCase().includes(needle);
		return {
			tags: (refs?.tags ?? []).filter(match).slice(0, REF_LIMIT),
			branches: (refs?.branches ?? []).filter(match).slice(0, REF_LIMIT)
		};
	});

	/** Break long dotted names at their separators instead of mid-word. */
	function breakable(name: string): string {
		return name.replace(/([./_-])/g, '$1\u200b');
	}

	/** Run one request at a time and show its failure on the screen. */
	async function attempt(kind: NonNullable<typeof busy>, work: () => Promise<void>) {
		if (busy) return;
		busy = kind;
		error = '';
		try {
			await work();
		} catch (cause) {
			error = errorMessage(cause);
		} finally {
			busy = null;
		}
	}

	function chooseConfig(value: string) {
		if (!repo) return;
		chosenConfig = value;
		saveConfig(repo.path, value);
	}

	function buildAndStart() {
		if (!repo) return;
		const target = repo;
		void attempt('build', async () => {
			await requestJson('/api/devcontainer/build', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					repoPath: target.path,
					repoName: target.name,
					...(config ? { configPath: config } : {})
				})
			});
			await dashboard.refreshWorkspaces();
		});
	}

	function startContainer() {
		if (!container) return;
		const id = container.id;
		void attempt('start', async () => {
			await requestJson(`/api/containers/${id}/start`, { method: 'POST' });
			await dashboard.refreshContainers();
		});
	}

	/** Cancel a running build, or dismiss a failed one and delete its log. */
	function dismissBuild(id: string) {
		void attempt('cancel', async () => {
			await requestJson('/api/devcontainer/build', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id })
			});
			await dashboard.refreshAll();
		});
	}

	async function openRefs() {
		if (!repo) return;
		sheet = 'ref';
		refs = null;
		refsError = '';
		refQuery = '';
		try {
			const data = await requestJson<{ branches: string[]; tags?: string[] }>(
				`/api/repos/branches?path=${encodeURIComponent(repo.path)}`
			);
			refs = { branches: data.branches, tags: data.tags ?? [] };
		} catch (cause) {
			refsError = errorMessage(cause);
		}
	}

	/** Check out a branch or tag; a dirty tree asks before a forced checkout. */
	function checkout(ref: { branch?: string; tag?: string }, force = false) {
		if (!repo) return;
		const target = repo;
		const current =
			(ref.branch && ref.branch === target.currentBranch) ||
			(ref.tag && ref.tag === target.currentTag);
		if (current) {
			sheet = null;
			return;
		}
		void attempt('checkout', async () => {
			try {
				await requestJson('/api/repos/checkout', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ path: target.path, ...ref, force })
				});
			} catch (cause) {
				if (!force && cause instanceof RequestError && cause.status === 409) {
					pendingRef = ref;
					sheet = 'force';
					return;
				}
				throw cause;
			}
			sheet = null;
			pendingRef = null;
			dashboard.toast(`Checked out ${ref.branch ?? ref.tag}`);
			await dashboard.refreshWorkspaces();
		});
	}

	/** Start a command and show it full screen. */
	function terminal(name: string, command: string, cwd: string) {
		sheet = null;
		const id = dashboard.openTerminal({ name, command, cwd, kind: 'shell' });
		void goto(resolve('/mobile/terminals/[id]', { id: id }));
	}

	/** A shell in the running container, else on the host in the repository folder. */
	function openTerminal() {
		if (!repo) return;
		const command = container && running ? containerShellCommand(container) : '';
		if (command === null) return;
		terminal(repo.name, command, repo.path);
	}

	/** OpenCode or OpenChamber for the host folder, through the AI launcher. */
	function openAi(tool: 'opencode' | 'openchamber') {
		if (!repo) return;
		sheet = null;
		const query = new URLSearchParams({ path: repo.path, tool, launch: generateId() });
		window.open(`${resolve('/ai')}?${query}`, '_blank', 'noopener,noreferrer');
	}

	function openOpenCode() {
		if (!repo) return;
		if (container && running) {
			const command = containerOpenCodeCommand(container);
			if (command) terminal(`${repo.name} \u00b7 OpenCode`, command, repo.path);
			return;
		}
		openAi('opencode');
	}

	function openChamber() {
		if (container && running && container.ports['3000']) {
			sheet = null;
			openMobileService({
				containerPort: '3000',
				hostPort: container.ports['3000'],
				label: 'OpenChamber',
				containerName: container.name,
				projectName: container.projectName,
				workspacePath: container.localWorkspacePath,
				allPorts: container.ports,
				containerId: container.id,
				serviceProxyEnabled: dashboard.serviceProxyEnabled
			});
			return;
		}
		openAi('openchamber');
	}

	async function copyVscode() {
		if (!repo) return;
		sheet = null;
		const host = dashboard.vscodeSshHost;
		const link =
			container && running
				? buildContainerVscodeUri(container, host)
				: host
					? `vscode://vscode-remote/ssh-remote+${host}${repo.path}?windowId=_blank`
					: `vscode://file${repo.path}?windowId=_blank`;
		try {
			await navigator.clipboard.writeText(link);
			dashboard.toast('Copied the VS Code link');
		} catch {
			dashboard.toast(`Copy failed: ${link}`);
		}
	}
</script>

<MNavBar
	back={{
		href: resolve('/mobile/workspaces/[workspace]', { workspace: key }),
		label: workspace?.name ?? 'Workspace'
	}}
>
	{#snippet right()}
		{#if repo}
			<MIconButton
				icon={ArrowUpRight}
				label="Open with"
				onclick={() => (sheet = 'open')}
				testid="repo-open-with"
			/>
		{/if}
	{/snippet}
</MNavBar>

{#if !repo || !workspace}
	<p class="px-8 py-12 text-center text-[16px] text-m-dim">This repository no longer exists.</p>
{:else}
	<div class="px-5 pb-5">
		<div class="text-[15px] text-m-dim">Repository</div>
		<h2 class="text-[26px] leading-tight font-bold [overflow-wrap:anywhere]">
			{breakable(repo.name)}
		</h2>
	</div>

	{#if error}
		<MBanner
			icon={TriangleAlert}
			tone="bg-m-stop/15 text-m-stop"
			title="That did not work"
			detail={error}
		/>
	{/if}

	<MGroup title="Checked out">
		<MRow
			tone="bg-m-run/15 text-m-run"
			subtitle={repo.currentTag ? 'Tag · detached HEAD' : repo.currentBranch ? 'Branch' : 'Unknown'}
			onclick={() => void openRefs()}
			testid="repo-ref"
		>
			{#snippet icon()}{#if repo.currentTag}<Tag size={18} />{:else}<GitBranch
						size={18}
					/>{/if}{/snippet}
			{#snippet title()}<span class="font-mono">{repo.currentTag ?? repo.currentBranch ?? '—'}</span
				>{/snippet}
			{#snippet trailing()}
				{#if busy === 'checkout'}<Loader2 size={18} class="animate-spin text-m-frost" />{:else}<span
						class="shrink-0 text-[16px] text-m-frost">Change</span
					>{/if}
			{/snippet}
		</MRow>
	</MGroup>

	{#if repo.hasDevcontainer}
		{#if build?.status === 'running'}
			<MGroup
				title="Devcontainer"
				footer="The build continues on the host if you leave this screen or lock the phone."
			>
				<div
					class="flex items-center gap-2 px-4 py-3.5 text-[16px] font-semibold text-m-warn"
					role="status"
				>
					<Loader2 size={17} class="animate-spin" />Building {config
						? configDisplayName(config)
						: ''}…
				</div>
				<MRow
					title="Build output"
					subtitle="Live, in a terminal"
					href={dashboard.terminalHref(build.id)}
					testid="build-output"
				>
					{#snippet icon()}<SquareTerminal size={18} />{/snippet}
				</MRow>
				<MRow
					title="Cancel build"
					danger
					tone="bg-m-stop/15 text-m-stop"
					onclick={() => dismissBuild(build.id)}
					disabled={busy !== null}
				>
					{#snippet icon()}<X size={18} />{/snippet}
				</MRow>
			</MGroup>
		{:else if running && container}
			<MGroup title="Devcontainer">
				<MRow
					title="Running"
					subtitle={container.name.replace(/^\//, '')}
					tone="bg-m-run/15"
					href={resolve('/mobile/containers/[id]', { id: container.id })}
				>
					{#snippet icon()}<MDot state="running" />{/snippet}
				</MRow>
				<MRow title="Terminal" onclick={openTerminal} chevron>
					{#snippet icon()}<SquareTerminal size={18} />{/snippet}
				</MRow>
				{#if container.ports['3000']}
					<MRow title="OpenChamber" tone="bg-m-frost/15 text-m-frost" onclick={openChamber}>
						{#snippet icon()}<Globe size={18} />{/snippet}
						{#snippet trailing()}<ArrowUpRight size={18} class="shrink-0 text-m-dim" />{/snippet}
					</MRow>
				{/if}
			</MGroup>
		{:else}
			{#if build?.status === 'failed'}
				<MBanner
					icon={TriangleAlert}
					tone="bg-m-stop/15 text-m-stop"
					title="The last build failed"
					detail={build.hasLog ? 'The output is kept as a log.' : undefined}
					action={build.hasLog ? 'View log' : 'Dismiss'}
					onAction={() => (build.hasLog ? (logOpen = true) : dismissBuild(build.id))}
				/>
			{/if}
			<MGroup
				title="Devcontainer"
				footer={container
					? 'A stopped container exists. Start keeps it; Build replaces it.'
					: 'No container yet. Build creates one from the selected configuration.'}
			>
				{#if repo.devcontainerConfigs.length > 1}
					<div class="pt-3">
						<div class="mb-2 px-4 text-[14px] text-m-dim">Configuration</div>
						<MSegmented
							label="Configuration"
							value={config ?? ''}
							onChange={chooseConfig}
							options={repo.devcontainerConfigs.map((path) => ({
								value: path,
								label: configDisplayName(path)
							}))}
						/>
					</div>
				{/if}
				<div class="grid gap-2 p-4">
					{#if container}
						<MButton onclick={startContainer} disabled={busy !== null} testid="repo-start">
							{#if busy === 'start'}<Loader2 size={18} class="animate-spin" />{:else}<Play
									size={18}
									class="fill-current"
								/>{/if}Start container
						</MButton>
					{/if}
					<MButton
						tone={container ? 'plain' : 'primary'}
						onclick={buildAndStart}
						disabled={busy !== null}
						testid="repo-build"
					>
						{#if busy === 'build'}<Loader2 size={18} class="animate-spin" />{:else}<Hammer
								size={18}
							/>{/if}
						Build and start{config && repo.devcontainerConfigs.length > 1
							? ` · ${configDisplayName(config)}`
							: ''}
					</MButton>
				</div>
			</MGroup>
		{/if}
	{:else}
		<MGroup footer="This repository has no devcontainer configuration.">
			<MRow title="Terminal on the host" subtitle={repo.path} onclick={openTerminal} chevron>
				{#snippet icon()}<SquareTerminal size={18} />{/snippet}
			</MRow>
		</MGroup>
	{/if}

	{#if composeFiles.length}
		<MGroup title="Compose sandbox">
			<MRow
				title="Configure, pull and start"
				subtitle={run
					? `${COMPOSE_ACTION_LABELS[run.action]}${run.tag ? ` ${run.tag}` : ''}: ${run.status === 'running' ? 'running' : run.status === 'failed' ? 'failed' : 'finished'}`
					: `${composeFiles.length} Compose ${composeFiles.length === 1 ? 'file' : 'files'}`}
				tone="bg-m-frost/15 text-m-frost"
				href={resolve('/mobile/workspaces/[workspace]/[repo]/sandbox', {
					workspace: key,
					repo: repo.name
				})}
				testid="repo-sandbox"
			>
				{#snippet icon()}{#if run?.status === 'running'}<Loader2
							size={18}
							class="animate-spin"
						/>{:else}<Boxes size={18} />{/if}{/snippet}
			</MRow>
		</MGroup>
	{/if}

	<MGroup title="Location">
		<MCopyRow label="Host path" value={repo.path} />
	</MGroup>

	<MSheet
		open={sheet === 'ref'}
		title={`Check out · ${repo.name}`}
		onClose={() => (sheet = null)}
		testid="ref-sheet"
	>
		<MSearch bind:value={refQuery} placeholder="Search branches and tags" />
		{#if refsError}
			<p role="alert" class="mx-5 mb-4 text-[15px] text-m-stop">{refsError}</p>
		{:else if !refs}
			<p role="status" class="py-6 text-center text-[15px] text-m-dim">
				Reading branches and tags…
			</p>
		{:else}
			{#if filteredRefs.branches.length}
				<MGroup title="Branches">
					{#each filteredRefs.branches as branch (branch)}
						<MRow
							title={branch}
							mono
							tone="bg-transparent text-m-glacier"
							onclick={() => checkout({ branch })}
							disabled={busy !== null}
						>
							{#snippet icon()}<GitBranch size={16} />{/snippet}
							{#snippet trailing()}{#if branch === repo.currentBranch}<Check
										size={20}
										class="shrink-0 text-m-frost"
									/>{/if}{/snippet}
						</MRow>
					{/each}
				</MGroup>
			{/if}
			{#if filteredRefs.tags.length}
				<MGroup
					title="Tags"
					footer={refs.tags.length > REF_LIMIT ? 'Search to find older tags.' : undefined}
				>
					{#each filteredRefs.tags as tag (tag)}
						<MRow
							title={tag}
							mono
							tone="bg-transparent text-m-run"
							onclick={() => checkout({ tag })}
							disabled={busy !== null}
						>
							{#snippet icon()}<Tag size={16} />{/snippet}
							{#snippet trailing()}{#if tag === repo.currentTag}<Check
										size={20}
										class="shrink-0 text-m-frost"
									/>{/if}{/snippet}
						</MRow>
					{/each}
				</MGroup>
			{/if}
			{#if !filteredRefs.branches.length && !filteredRefs.tags.length}
				<p class="py-6 text-center text-[15px] text-m-dim">Nothing matches.</p>
			{/if}
		{/if}
	</MSheet>

	<MSheet open={sheet === 'force'} title="Uncommitted changes" onClose={() => (sheet = null)}>
		<MConfirm
			title="The working tree has uncommitted changes"
			body={`A forced checkout of ${pendingRef?.branch ?? pendingRef?.tag ?? ''} can discard them.`}
			action="Force checkout"
			tone="warn"
			busy={busy === 'checkout'}
			onConfirm={() => pendingRef && checkout(pendingRef, true)}
			onCancel={() => (sheet = null)}
		/>
	</MSheet>

	<MSheet open={sheet === 'open'} title={`Open ${repo.name}`} onClose={() => (sheet = null)}>
		<MGroup
			footer={running ? 'Inside the running container.' : 'On the host, in the repository folder.'}
		>
			<MRow title="Terminal" onclick={openTerminal} chevron>
				{#snippet icon()}<SquareTerminal size={18} />{/snippet}
			</MRow>
			<MRow title="OpenCode TUI" tone="bg-m-brain/15 text-m-brain" onclick={openOpenCode} chevron>
				{#snippet icon()}<Bot size={18} />{/snippet}
			</MRow>
			<MRow title="OpenChamber" tone="bg-m-frost/15 text-m-frost" onclick={openChamber}>
				{#snippet icon()}<Globe size={18} />{/snippet}
				{#snippet trailing()}<ArrowUpRight size={18} class="shrink-0 text-m-dim" />{/snippet}
			</MRow>
			<MRow
				title="Copy VS Code link"
				subtitle="Open it on your computer"
				tone="bg-m-glacier/15 text-m-glacier"
				onclick={() => void copyVscode()}
			>
				{#snippet icon()}<Code size={18} />{/snippet}
				{#snippet trailing()}<Copy size={17} class="shrink-0 text-m-frost" />{/snippet}
			</MRow>
		</MGroup>
	</MSheet>

	{#if build?.hasLog}
		<MLogSheet
			open={logOpen}
			logId={build.id}
			title={`${repo.name} build log`}
			onClose={() => (logOpen = false)}
		/>
	{/if}
{/if}
