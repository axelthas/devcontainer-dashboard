<script lang="ts">
	/**
	 * Compose sandbox on the phone: the decision on top (which version, and what changes),
	 * one large action, and the rarer actions and the configuration one level down.
	 * While an action runs, its live Compose output replaces the controls.
	 */
	import {
		Boxes,
		Check,
		CloudDownload,
		Code,
		FileText,
		Hammer,
		Layers,
		Loader2,
		Network,
		Play,
		RefreshCw,
		ScrollText,
		Square,
		SquareTerminal,
		Tag,
		Trash2,
		TriangleAlert,
		X
	} from 'lucide-svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { COMPOSE_ACTION_LABELS, type ComposeAction } from '$lib/composeCommands';
	import { runLabel, useComposeSandbox } from '$lib/mobile/composeSandbox.svelte';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';
	import SandboxRemoveDialog from '$lib/components/SandboxRemoveDialog.svelte';
	import TerminalTab from '$lib/components/TerminalTab.svelte';
	import MBanner from '$lib/components/mobile/MBanner.svelte';
	import MButton from '$lib/components/mobile/MButton.svelte';
	import MChip from '$lib/components/mobile/MChip.svelte';
	import MGroup from '$lib/components/mobile/MGroup.svelte';
	import MIconButton from '$lib/components/mobile/MIconButton.svelte';
	import MLogSheet from '$lib/components/mobile/MLogSheet.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';
	import MRow from '$lib/components/mobile/MRow.svelte';
	import MSheet from '$lib/components/mobile/MSheet.svelte';

	const dashboard = useMobileDashboard();
	const sandbox = useComposeSandbox();
	const key = $derived(page.params.workspace ?? '');
	const repo = $derived(sandbox.repo);
	const inspection = $derived(sandbox.inspection);
	const run = $derived(sandbox.run);
	const projectName = $derived(inspection?.projectName ?? repo.name);
	const serviceCount = $derived(inspection?.services.length ?? 0);
	const repoHref = $derived(
		resolve('/mobile/workspaces/[workspace]/[repo]', { workspace: key, repo: repo.name })
	);
	const servicesHref = $derived(
		resolve('/mobile/workspaces/[workspace]/[repo]/sandbox/services', {
			workspace: key,
			repo: repo.name
		})
	);
	const versionLabel = $derived(sandbox.tag || 'Compose file default');
	/** Pull and start leads while images are missing; Start leads otherwise. */
	const pullFirst = $derived(sandbox.missingImages.length > 0);
	const startBlocker = $derived(sandbox.blocker('up'));
	const mainBlocker = $derived(sandbox.blocker(pullFirst ? 'up-pull' : 'up'));
	const stackOnHost = $derived(
		dashboard.stacks.some((stack) => stack.name === inspection?.projectName)
	);

	type Sheet = 'version' | 'config' | 'actions' | 'calls' | null;
	let sheet = $state<Sheet>(null);
	let removing = $state(false);
	let logOpen = $state(false);
	let tagDraft = $state('');

	/** Start an action from the screen or a sheet, and show its progress on top. */
	async function act(action: ComposeAction, services?: string[], label?: string) {
		sheet = null;
		const started = await sandbox.start(action, services, label ?? action);
		if (started) window.scrollTo({ top: 0, behavior: 'smooth' });
	}

	function openVersion() {
		tagDraft = sandbox.tagText;
		sheet = 'version';
		if (!sandbox.listing && !sandbox.tagsLoading) void sandbox.loadTags();
	}

	function chooseTag(tag: string) {
		sandbox.tagText = tag;
		sheet = null;
	}

	/** Follow the logs of the selected services in a full-screen terminal. */
	function followLogs() {
		const logs = sandbox.logsCommand();
		if (!logs) return;
		sheet = null;
		const id = dashboard.openTerminal({ ...logs, kind: 'shell' });
		void goto(dashboard.terminalHref(id));
	}

	async function copyCalls() {
		try {
			await navigator.clipboard.writeText(sandbox.commandPreview);
			dashboard.toast('Copied the Docker calls');
		} catch {
			dashboard.toast('Copy failed: select the text');
		}
	}
</script>

<MNavBar back={{ href: repoHref, label: repo.name }}>
	{#snippet right()}
		<MIconButton
			label="Sandbox actions"
			onclick={() => (sheet = 'actions')}
			testid="sandbox-actions"
		/>
	{/snippet}
</MNavBar>

<div class="px-5 pb-4">
	<div class="flex items-center gap-2 text-[15px] text-m-dim">
		<Boxes size={16} />Compose sandbox
	</div>
	<h2
		class="text-[26px] leading-tight font-bold [overflow-wrap:anywhere]"
		data-testid="sandbox-project"
	>
		{projectName}
	</h2>
	<div class="mt-2 flex flex-wrap gap-1.5">
		{#if inspection}
			<MChip tone={sandbox.runningCount ? 'border-m-run/50 text-m-run' : undefined}
				>{sandbox.runningCount}/{serviceCount} running</MChip
			>
		{/if}
		{#if sandbox.runningVersion}
			<MChip>runs {sandbox.runningVersion.label}</MChip>
		{/if}
		{#if sandbox.inspecting}
			<MChip><Loader2 size={12} class="animate-spin" />checking</MChip>
		{/if}
	</div>
</div>

{#if run?.status === 'running'}
	<MGroup
		title={runLabel(run)}
		footer="The run continues on the host if you leave, lock the phone or lose the connection."
	>
		<div class="px-4 pt-3.5 pb-3" data-testid="sandbox-run">
			<div class="flex items-center gap-2 text-[16px] font-semibold text-m-warn" role="status">
				<Loader2 size={17} class="animate-spin" />{COMPOSE_ACTION_LABELS[run.action]}{run.tag
					? ` ${run.tag}`
					: ''} running…
			</div>
			<div class="mt-3 h-56 overflow-hidden rounded-lg bg-m-term">
				<!-- Pull and start replaces the Pull run with a Start run: attach to the new session -->
				{#key run.id}
					<TerminalTab
						sessionId={run.id}
						active={true}
						fontSize={11}
						onExit={() => sandbox.runExited()}
					/>
				{/key}
			</div>
		</div>
		<MRow title="Full output" subtitle="Opens as a terminal" href={dashboard.terminalHref(run.id)}>
			{#snippet icon()}<SquareTerminal size={18} />{/snippet}
		</MRow>
		<MRow
			title="Cancel run"
			subtitle="Containers that Compose already created stay"
			danger
			tone="bg-m-stop/15 text-m-stop"
			onclick={() => void sandbox.removeRun(run.id)}
			testid="sandbox-cancel"
		>
			{#snippet icon()}<X size={18} />{/snippet}
		</MRow>
	</MGroup>
{:else if run?.status === 'failed'}
	<MBanner
		icon={TriangleAlert}
		tone="bg-m-stop/15 text-m-stop"
		title={`${runLabel(run)} failed`}
		detail={run.hasLog ? 'The output is kept as a log.' : undefined}
		action="Dismiss"
		onAction={() => void sandbox.removeRun(run.id)}
	/>
	{#if run.hasLog}
		<MGroup>
			<MRow title="View log" onclick={() => (logOpen = true)}>
				{#snippet icon()}<FileText size={18} />{/snippet}
			</MRow>
		</MGroup>
	{/if}
{:else if run}
	<MBanner
		icon={Check}
		tone="bg-m-run/15 text-m-run"
		title={`${runLabel(run)} finished`}
		detail={sandbox.runningOutside.length
			? `${sandbox.runningOutside.length} unselected services kept their state.`
			: undefined}
		action="Dismiss"
		onAction={() => void sandbox.removeRun(run.id)}
		testid="sandbox-finished"
	/>
	{#if stackOnHost && inspection}
		<MGroup>
			<MRow
				title="Open the stack"
				subtitle="Services, ports and shells"
				tone="bg-m-frost/15 text-m-frost"
				href={resolve('/mobile/services/[stack]', { stack: inspection.projectName })}
			>
				{#snippet icon()}<Layers size={18} />{/snippet}
			</MRow>
		</MGroup>
	{/if}
{/if}

{#if sandbox.inspectError}
	<MBanner
		icon={TriangleAlert}
		tone="bg-m-stop/15 text-m-stop"
		title="The configuration check failed"
		detail={sandbox.inspectError}
		action="Retry"
		onAction={() => void sandbox.inspect()}
	/>
{/if}
{#if sandbox.actionError}
	<MBanner
		icon={TriangleAlert}
		tone="bg-m-stop/15 text-m-stop"
		title="The action did not start"
		detail={sandbox.actionError}
	/>
{/if}
{#if inspection && sandbox.fresh && inspection.ownership === 'other'}
	<MBanner
		icon={TriangleAlert}
		tone="bg-m-stop/15 text-m-stop"
		title={`${inspection.projectName} belongs to another folder`}
		detail={`Containers come from ${inspection.otherWorkingDirs.join(', ')}. Actions are off: Compose would change that stack. Stop it from its own repository.`}
	/>
{/if}

{#if run?.status !== 'running'}
	<MGroup title="Version">
		<MRow
			subtitle="One tag for every registry service"
			tone="bg-m-frost/15 text-m-frost"
			onclick={openVersion}
			testid="sandbox-version"
		>
			{#snippet icon()}<Tag size={18} />{/snippet}
			{#snippet title()}<span class="font-mono font-semibold">{versionLabel}</span>{/snippet}
			{#snippet trailing()}<span class="shrink-0 text-[16px] text-m-frost">Change</span>{/snippet}
		</MRow>
	</MGroup>
	{#if sandbox.fresh && sandbox.switching && sandbox.runningVersion}
		<MBanner
			icon={TriangleAlert}
			tone="bg-m-beak/15 text-m-beak"
			title={`Switches ${sandbox.runningVersion.label} → ${sandbox.tag}`}
			detail="Start recreates the containers whose image changes."
		/>
	{/if}
	{#if sandbox.fresh && sandbox.missingImages.length}
		<MBanner
			icon={CloudDownload}
			tone="bg-m-glacier/15 text-m-glacier"
			title={`${sandbox.missingImages.length} ${sandbox.missingImages.length === 1 ? 'image is' : 'images are'} not on this host`}
			detail={`${sandbox.missingImages.map((service) => service.name).join(', ')}. Pull them first.`}
			testid="sandbox-missing"
		/>
	{/if}

	<div class="mx-4 mb-6 grid gap-2">
		{#if pullFirst}
			<MButton
				onclick={() => void act('up-pull')}
				disabled={Boolean(mainBlocker)}
				testid="sandbox-pull-start"
			>
				{#if sandbox.starting === 'up-pull'}<Loader2
						size={18}
						class="animate-spin"
					/>{:else}<CloudDownload size={19} />{/if}
				Pull and start{sandbox.tag ? ` ${sandbox.tag}` : ''}
			</MButton>
		{:else}
			<MButton
				onclick={() => void act('up')}
				disabled={Boolean(mainBlocker)}
				testid="sandbox-start"
			>
				{#if sandbox.starting === 'up'}<Loader2 size={18} class="animate-spin" />{:else}<Play
						size={18}
						class="fill-current"
					/>{/if}
				Start{sandbox.tag ? ` ${sandbox.tag}` : ''}
			</MButton>
		{/if}
		<div class="grid grid-cols-2 gap-2">
			{#if pullFirst}
				<MButton
					tone="plain"
					onclick={() => void act('up')}
					disabled={Boolean(startBlocker)}
					testid="sandbox-start"
				>
					<Play size={17} />Start
				</MButton>
			{:else}
				<MButton
					tone="plain"
					onclick={() => void act('up-pull')}
					disabled={Boolean(sandbox.blocker('up-pull'))}
					testid="sandbox-pull-start"
				>
					{#if sandbox.starting === 'up-pull'}<Loader2
							size={17}
							class="animate-spin"
						/>{:else}<CloudDownload size={17} />{/if}Pull and start
				</MButton>
			{/if}
			<MButton
				tone="plain"
				onclick={() => void act('up-build')}
				disabled={Boolean(sandbox.blocker('up-build'))}
				testid="sandbox-build-start"
			>
				{#if sandbox.starting === 'up-build'}<Loader2
						size={17}
						class="animate-spin"
					/>{:else}<Hammer size={17} />{/if}Build and start
			</MButton>
		</div>
		{#if mainBlocker || (pullFirst && startBlocker)}
			<p class="px-1 text-[14px] leading-snug text-m-dim" data-testid="sandbox-blocker">
				{mainBlocker ?? startBlocker}
			</p>
		{/if}
	</div>
{/if}

<MGroup title="What runs">
	<MRow
		title={inspection ? `${sandbox.effective.length} of ${serviceCount} services` : 'Services'}
		subtitle={inspection
			? [
					sandbox.implied.length ? `${sandbox.implied.length} as dependencies` : null,
					serviceCount - sandbox.effective.length
						? `${serviceCount - sandbox.effective.length} left out`
						: null
				]
					.filter(Boolean)
					.join(' · ') || 'All selected'
			: 'Available after the configuration check'}
		href={servicesHref}
		testid="sandbox-services"
	>
		{#snippet icon()}<Boxes size={18} />{/snippet}
	</MRow>
	{#if inspection?.networks.length}
		<MRow
			title={`${inspection.networks.length} ${inspection.networks.length === 1 ? 'network' : 'networks'}`}
			subtitle={inspection.networks
				.map((network) => `${network.name}${network.external ? ' (external)' : ''}`)
				.join(', ')}
			tone="bg-m-glacier/15 text-m-glacier"
		>
			{#snippet icon()}<Network size={18} />{/snippet}
		</MRow>
	{/if}
</MGroup>

<MGroup
	title="Configuration"
	footer="Saved per repository. Other clones of this repository start from the same files."
>
	<MRow
		title="Compose files"
		subtitle={sandbox.selectedFiles.join(' + ') || 'None selected'}
		onclick={() => (sheet = 'config')}
		chevron
		testid="sandbox-files"
	>
		{#snippet icon()}<FileText size={18} />{/snippet}
	</MRow>
	<MRow
		title="Environment file"
		subtitle={sandbox.envFile || '.env in the project directory'}
		onclick={() => (sheet = 'config')}
		chevron
	/>
	<MRow
		title="Profiles"
		subtitle={sandbox.profilesText || 'None'}
		onclick={() => (sheet = 'config')}
		chevron
	/>
</MGroup>

{#if inspection?.warnings.length}
	<MGroup title="Compose warnings">
		{#each inspection.warnings as warning, index (index)}
			<div class="px-4 py-2.5 text-[14px] leading-snug [overflow-wrap:anywhere] text-m-beak">
				{warning}
			</div>
		{/each}
	</MGroup>
{/if}

<MSheet
	open={sheet === 'version'}
	title="Sandbox version"
	onClose={() => (sheet = null)}
	testid="version-sheet"
>
	<div class="mx-4 mb-3 flex items-center gap-2">
		<input
			type="text"
			bind:value={tagDraft}
			placeholder="Type a tag"
			aria-label="Sandbox version"
			autocapitalize="off"
			autocomplete="off"
			spellcheck="false"
			onkeydown={(event) => event.key === 'Enter' && chooseTag(tagDraft.trim())}
			class="min-h-11 min-w-0 flex-1 rounded-xl border-none bg-m-raised px-3 font-mono text-[16px] text-m-ink placeholder:text-m-dim focus:ring-2 focus:ring-m-frost"
		/>
		<button
			type="button"
			onclick={() => chooseTag(tagDraft.trim())}
			class="min-h-11 shrink-0 rounded-xl bg-m-frost px-4 text-[16px] font-semibold text-m-on-frost"
			>Use</button
		>
		<MIconButton
			icon={RefreshCw}
			label="Refresh registry tags"
			onclick={() => void sandbox.loadTags(true)}
		/>
	</div>
	<MGroup>
		<MRow
			title="Compose file default"
			subtitle="The image references as written"
			onclick={() => chooseTag('')}
		>
			{#snippet trailing()}{#if !sandbox.tag}<Check
						size={20}
						class="shrink-0 text-m-frost"
					/>{/if}{/snippet}
		</MRow>
	</MGroup>
	{#if sandbox.tagsLoading}
		<p role="status" class="py-4 text-center text-[15px] text-m-dim">Reading registry tags…</p>
	{:else if sandbox.tagsError}
		<p role="alert" class="mx-5 mb-4 text-[15px] text-m-stop">{sandbox.tagsError}</p>
	{/if}
	{#each sandbox.listingFailures as image (image.repository)}
		<p class="mx-5 mb-3 text-[14px] leading-snug [overflow-wrap:anywhere] text-m-beak">
			{image.error?.message}. Type the tag; Pull uses the same credentials.
		</p>
	{/each}
	{#if sandbox.listing?.tags.length}
		<MGroup title="From the registry" footer="Tags of the images of the selected services.">
			{#each sandbox.listing.tags as tag (tag.name)}
				<MRow
					title={tag.name}
					mono
					tone="bg-transparent text-m-frost"
					onclick={() => chooseTag(tag.name)}
					testid="version-tag"
				>
					{#snippet icon()}<Tag size={16} />{/snippet}
					{#snippet subtitle()}
						{#if tag.missingIn.length}<span class="text-m-beak"
								>missing in {tag.missingIn.join(', ')}</span
							>{:else if tag.name === sandbox.runningVersion?.label}running now{/if}
					{/snippet}
					{#snippet trailing()}{#if tag.name === sandbox.tag}<Check
								size={20}
								class="shrink-0 text-m-frost"
							/>{/if}{/snippet}
				</MRow>
			{/each}
		</MGroup>
	{/if}
</MSheet>

<MSheet
	open={sheet === 'config'}
	title="Configuration"
	onClose={() => (sheet = null)}
	testid="config-sheet"
>
	{#if sandbox.directories.length > 1}
		<MGroup title="Project directory">
			{#each sandbox.directories as directory (directory)}
				<MRow
					title={directory || 'Repository root'}
					mono
					onclick={() => sandbox.selectDirectory(directory)}
				>
					{#snippet trailing()}{#if directory === sandbox.directory}<Check
								size={20}
								class="shrink-0 text-m-frost"
							/>{/if}{/snippet}
				</MRow>
			{/each}
		</MGroup>
	{/if}
	<MGroup
		title="Compose files, in merge order"
		footer="Later files override earlier ones. The version override always comes last."
	>
		{#each sandbox.directoryFiles as file (file)}
			{@const on = sandbox.selectedFiles.includes(file)}
			<button
				type="button"
				role="checkbox"
				aria-checked={on}
				onclick={() => sandbox.toggleFile(file)}
				class="flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5 text-left"
			>
				<span
					class="flex size-[26px] shrink-0 items-center justify-center rounded-full border-2 {on
						? 'border-m-frost bg-m-frost text-m-on-frost'
						: 'border-m-edge'}"
					>{#if on}<Check size={15} strokeWidth={3} />{/if}</span
				>
				<span class="min-w-0 flex-1 font-mono text-[15px] [overflow-wrap:anywhere]">{file}</span>
			</button>
		{/each}
	</MGroup>
	<MGroup title="Environment file">
		<input
			type="text"
			bind:value={sandbox.envFile}
			placeholder=".env in the project directory"
			aria-label="Environment file"
			autocapitalize="off"
			spellcheck="false"
			class="block min-h-[52px] w-full border-none bg-transparent px-4 font-mono text-[16px] text-m-ink placeholder:text-m-dim focus:ring-0"
		/>
	</MGroup>
	<MGroup title="Profiles" footer="Separate profiles with spaces or commas.">
		<input
			type="text"
			bind:value={sandbox.profilesText}
			placeholder="None"
			aria-label="Profiles"
			autocapitalize="off"
			spellcheck="false"
			class="block min-h-[52px] w-full border-none bg-transparent px-4 font-mono text-[16px] text-m-ink placeholder:text-m-dim focus:ring-0"
		/>
	</MGroup>
</MSheet>

<MSheet
	open={sheet === 'actions'}
	title={projectName}
	onClose={() => (sheet = null)}
	testid="sandbox-actions-sheet"
>
	<MGroup title="Run one step">
		<MRow
			title="Pull only"
			subtitle={sandbox.blocker('pull') ?? 'Download images, start nothing'}
			onclick={() => void act('pull')}
			disabled={Boolean(sandbox.blocker('pull'))}
		>
			{#snippet icon()}<CloudDownload size={18} />{/snippet}
		</MRow>
		<MRow
			title="Build only"
			subtitle={sandbox.blocker('build') ?? 'Build the selected services, start nothing'}
			onclick={() => void act('build')}
			disabled={Boolean(sandbox.blocker('build'))}
		>
			{#snippet icon()}<Hammer size={18} />{/snippet}
		</MRow>
		<MRow
			title="Stop"
			subtitle={sandbox.blocker('stop') ?? 'Every service of the project'}
			onclick={() => void act('stop')}
			disabled={Boolean(sandbox.blocker('stop'))}
		>
			{#snippet icon()}<Square size={16} />{/snippet}
		</MRow>
		{#if sandbox.fresh && sandbox.runningOutside.length}
			<MRow
				title={`Stop unselected (${sandbox.runningOutside.length})`}
				subtitle={sandbox.runningOutside.join(', ')}
				onclick={() => void act('stop', sandbox.runningOutside, 'stop-unselected')}
				disabled={sandbox.blocked}
			>
				{#snippet icon()}<Square size={16} />{/snippet}
			</MRow>
		{/if}
	</MGroup>
	<MGroup>
		<MRow
			title="Follow service logs"
			onclick={followLogs}
			disabled={!sandbox.fresh || !inspection?.containers.length}
			chevron
		>
			{#snippet icon()}<ScrollText size={18} />{/snippet}
		</MRow>
		<MRow
			title="Show Docker calls"
			subtitle="The exact commands each action runs"
			onclick={() => (sheet = 'calls')}
			disabled={!sandbox.commandPreview}
			chevron
		>
			{#snippet icon()}<Code size={18} />{/snippet}
		</MRow>
		<MRow
			title="Check the configuration again"
			onclick={() => {
				sheet = null;
				void sandbox.inspect();
			}}
		>
			{#snippet icon()}<RefreshCw size={18} />{/snippet}
		</MRow>
	</MGroup>
	<MGroup
		footer="Removes the containers and project networks. Volumes, images and source files stay."
	>
		<MRow
			title="Remove sandbox…"
			danger
			tone="bg-m-stop/15 text-m-stop"
			onclick={() => {
				sheet = null;
				removing = true;
			}}
			disabled={!sandbox.fresh || inspection?.ownership !== 'this' || run?.status === 'running'}
			chevron
		>
			{#snippet icon()}<Trash2 size={18} />{/snippet}
		</MRow>
	</MGroup>
</MSheet>

<MSheet open={sheet === 'calls'} title="Docker calls" onClose={() => (sheet = null)}>
	<div class="px-4">
		<pre
			class="max-h-[55dvh] overflow-auto rounded-xl bg-m-term p-3 font-mono text-[13px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-[#d8dee9]">{sandbox.commandPreview}</pre>
		<div class="mt-3"><MButton tone="plain" onclick={() => void copyCalls()}>Copy</MButton></div>
	</div>
</MSheet>

{#if removing && inspection}
	<SandboxRemoveDialog
		project={inspection.projectName}
		onClose={() => (removing = false)}
		onRemoved={() => sandbox.runExited()}
	/>
{/if}
{#if run?.hasLog}
	<MLogSheet
		open={logOpen}
		logId={run.id}
		title={`${repo.name} ${runLabel(run)} log`}
		onClose={() => (logOpen = false)}
	/>
{/if}
