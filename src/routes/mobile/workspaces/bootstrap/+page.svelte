<script lang="ts">
	/**
	 * Dev Bootstrap: its version and source branch, updates, and new workspaces from presets.
	 * Every run opens its own terminal and continues on the host if the phone leaves.
	 * Preset editing stays on the desktop dashboard.
	 */
	import {
		Check,
		Download,
		GitBranch,
		Loader2,
		Package,
		Play,
		RefreshCw,
		TriangleAlert
	} from 'lucide-svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { errorMessage, requestJson } from '$lib/requests';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';
	import type { BootstrapPreset, BootstrapProvider, BootstrapToolInfo } from '$lib/types';
	import MBanner from '$lib/components/mobile/MBanner.svelte';
	import MChip from '$lib/components/mobile/MChip.svelte';
	import MGroup from '$lib/components/mobile/MGroup.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';
	import MRow from '$lib/components/mobile/MRow.svelte';
	import MNewWorkspaceSheet from '$lib/components/mobile/MNewWorkspaceSheet.svelte';
	import MSheet from '$lib/components/mobile/MSheet.svelte';

	const dashboard = useMobileDashboard();
	let info = $state<BootstrapToolInfo | null>(null);
	let provider = $state<BootstrapProvider | null>(null);
	let presets = $state<BootstrapPreset[]>([]);
	let loading = $state(true);
	let error = $state('');
	let busy = $state<'pull' | 'checkout' | null>(null);
	let message = $state('');
	let sheet = $state<'branch' | null>(null);
	/** The preset whose form is open in the New workspace sheet. */
	let preset = $state<BootstrapPreset | null>(null);

	const branches = $derived([
		...new Set([...(info?.availableBranches ?? []), ...(info?.remoteBranches ?? [])])
	]);

	async function load() {
		loading = true;
		error = '';
		try {
			const [nextInfo, providers, nextPresets] = await Promise.all([
				requestJson<BootstrapToolInfo>('/api/bootstrap'),
				requestJson<BootstrapProvider[]>('/api/bootstrap/providers'),
				requestJson<BootstrapPreset[]>('/api/presets')
			]);
			info = nextInfo;
			provider = providers[0] ?? null;
			presets = nextPresets;
		} catch (cause) {
			error = errorMessage(cause);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void load();
	});

	async function pull() {
		busy = 'pull';
		message = '';
		try {
			const data = await requestJson<{ output?: string }>('/api/bootstrap/pull', {
				method: 'POST'
			});
			message = data.output || 'Pull complete';
			await load();
		} catch (cause) {
			error = errorMessage(cause);
		} finally {
			busy = null;
		}
	}

	async function checkout(branch: string) {
		if (branch === info?.currentBranch) {
			sheet = null;
			return;
		}
		busy = 'checkout';
		try {
			await requestJson('/api/bootstrap/checkout', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ branch })
			});
			sheet = null;
			await load();
		} catch (cause) {
			error = errorMessage(cause);
			sheet = null;
		} finally {
			busy = null;
		}
	}

	/** The update runs in its own terminal, as on the desktop. */
	function update() {
		if (!provider) return;
		const id = dashboard.openTerminal({
			name: `Update ${provider.name}`,
			command: provider.commands.update,
			kind: 'bootstrap'
		});
		void goto(resolve('/mobile/terminals/[id]', { id: id }));
	}
</script>

<MNavBar back={{ href: resolve('/mobile/workspaces'), label: 'Workspaces' }} />

<div class="px-5 pb-5">
	<div class="flex items-center gap-2 text-[15px] text-m-dim">
		<Package size={16} />Dev Bootstrap
	</div>
	{#if info?.installed}
		<div class="flex flex-wrap items-baseline gap-2">
			<h2 class="font-mono text-[30px] font-bold">{info.version ?? 'unknown'}</h2>
			{#if info.currentBranch}<MChip tone="border-m-brain/50 text-m-brain"
					>{info.currentBranch}</MChip
				>{/if}
		</div>
	{:else if loading}
		<p role="status" class="mt-2 text-[16px] text-m-dim">Reading the installation…</p>
	{:else}
		<h2 class="text-[26px] font-bold">Not installed</h2>
	{/if}
</div>

{#if error}
	<MBanner
		icon={TriangleAlert}
		tone="bg-m-stop/15 text-m-stop"
		title="Bootstrap status unavailable"
		detail={error}
		action="Retry"
		onAction={() => void load()}
	/>
{/if}
{#if message}
	<MBanner
		icon={Check}
		tone="bg-m-run/15 text-m-run"
		title="Pulled"
		detail={message}
		action="OK"
		onAction={() => (message = '')}
	/>
{/if}

{#if info?.installed}
	<MGroup title="Source" footer={info.repoPath}>
		<MRow
			title="Branch"
			subtitle={info.currentBranch ?? 'Detached'}
			onclick={() => (sheet = 'branch')}
			disabled={!branches.length || busy !== null}
		>
			{#snippet icon()}<GitBranch size={18} />{/snippet}
			{#snippet trailing()}{#if busy === 'checkout'}<Loader2
						size={18}
						class="animate-spin text-m-frost"
					/>{:else}<span class="shrink-0 text-[16px] text-m-frost">Change</span>{/if}{/snippet}
		</MRow>
		<MRow title="Pull latest" onclick={() => void pull()} disabled={busy !== null}>
			{#snippet icon()}{#if busy === 'pull'}<Loader2
						size={18}
						class="animate-spin"
					/>{:else}<Download size={18} />{/if}{/snippet}
		</MRow>
		{#if provider}
			<MRow
				title={`Update ${provider.name}`}
				subtitle="Runs the installer in a terminal"
				tone="bg-m-brain/15 text-m-brain"
				onclick={update}
				chevron
			>
				{#snippet icon()}<RefreshCw size={18} />{/snippet}
			</MRow>
		{/if}
	</MGroup>
{/if}

{#if presets.length}
	<MGroup
		title="New workspace"
		footer="Each run opens its own terminal. Edit presets on the desktop dashboard."
	>
		{#each presets as item (item.id)}
			<MRow
				title={item.name}
				subtitle={item.command}
				onclick={() => (preset = item)}
				chevron
				testid="bootstrap-preset"
			>
				{#snippet icon()}<Play size={17} />{/snippet}
			</MRow>
		{/each}
	</MGroup>
{:else if !loading}
	<p class="px-8 py-6 text-center text-[15px] text-m-dim">
		No presets. Add them on the desktop dashboard.
	</p>
{/if}

<MSheet open={sheet === 'branch'} title="Dev Bootstrap branch" onClose={() => (sheet = null)}>
	<MGroup>
		{#each branches as branch (branch)}
			<MRow
				title={branch}
				mono
				tone="bg-transparent text-m-glacier"
				onclick={() => void checkout(branch)}
				disabled={busy !== null}
			>
				{#snippet icon()}<GitBranch size={16} />{/snippet}
				{#snippet trailing()}{#if branch === info?.currentBranch}<Check
							size={20}
							class="shrink-0 text-m-frost"
						/>{/if}{/snippet}
			</MRow>
		{/each}
	</MGroup>
</MSheet>

<MNewWorkspaceSheet
	open={preset !== null}
	onClose={() => (preset = null)}
	{presets}
	initial={preset}
/>
