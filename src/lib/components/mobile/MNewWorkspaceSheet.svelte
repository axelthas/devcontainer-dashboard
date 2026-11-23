<script lang="ts">
	/**
	 * New workspace from a Dev Bootstrap preset, in one sheet with two steps:
	 * choose a preset, then fill in its destination folder and command and run it.
	 * The run continues on the host; the sheet closes and its terminal opens.
	 * Preset editing stays on the desktop dashboard.
	 */
	import { Loader2, Package, Play, TriangleAlert } from 'lucide-svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { errorMessage, requestJson } from '$lib/requests';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';
	import type { BootstrapPreset } from '$lib/types';
	import MBanner from './MBanner.svelte';
	import MButton from './MButton.svelte';
	import MGroup from './MGroup.svelte';
	import MRow from './MRow.svelte';
	import MSheet from './MSheet.svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
		/** Presets already loaded by the caller. Without them the sheet loads them. */
		presets?: BootstrapPreset[];
		/** Open on the form of this preset instead of the preset list. */
		initial?: BootstrapPreset | null;
		/** Show the link to the Dev Bootstrap screen. */
		manageLink?: boolean;
	}
	let { open, onClose, presets, initial = null, manageLink = false }: Props = $props();

	const dashboard = useMobileDashboard();
	let loaded = $state<BootstrapPreset[] | null>(null);
	let loading = $state(false);
	let loadError = $state('');
	/** The preset picked in the list. Cleared when the sheet closes. */
	let picked = $state<BootstrapPreset | null>(null);
	const preset = $derived(picked ?? initial);
	// Each preset starts with its own command and an empty folder; the user edits both.
	let command = $derived(preset?.command ?? '');
	let destDir = $derived(preset ? '' : '');
	let running = $state(false);
	let runError = $state('');

	const choices = $derived(presets ?? loaded ?? []);
	const showCommand = $derived(!preset?.fields || preset.fields.includes('command'));
	const showDestDir = $derived(!preset?.fields || preset.fields.includes('destDir'));
	const ready = $derived(
		!running &&
			(!showCommand || Boolean(command.trim())) &&
			(!showDestDir || Boolean(destDir.trim()))
	);

	/** Read the presets for the list. */
	async function loadPresets() {
		loading = true;
		loadError = '';
		try {
			loaded = await requestJson<BootstrapPreset[]>('/api/presets');
		} catch (cause) {
			loadError = errorMessage(cause);
		} finally {
			loading = false;
		}
	}

	// Read the presets when the sheet opens, unless the caller gave them.
	$effect(() => {
		if (open && !presets) void loadPresets();
	});

	/** Pick a preset in the list and show its form. */
	function pick(next: BootstrapPreset | null) {
		picked = next;
		runError = '';
	}

	/** Close and forget the pick, so the next opening starts on the list. */
	function close() {
		pick(null);
		onClose();
	}

	/** Start the run on the server, then attach to its terminal session. */
	async function run() {
		if (!preset || !ready) return;
		running = true;
		runError = '';
		try {
			const { id } = await requestJson<{ id: string; workspacePath: string }>(
				'/api/bootstrap/run',
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						command: command.trim().replaceAll('{destDir}', destDir.trim()),
						name: preset.name,
						destDir: showDestDir ? destDir.trim() : ''
					})
				}
			);
			close();
			void dashboard.refreshWorkspaces().catch(() => {});
			await goto(resolve('/mobile/terminals/[id]', { id }));
		} catch (cause) {
			runError = errorMessage(cause);
		} finally {
			running = false;
		}
	}

	/** Leave the sheet for the Dev Bootstrap screen. */
	function manage() {
		close();
		void goto(resolve('/mobile/workspaces/bootstrap'));
	}
</script>

<MSheet
	{open}
	title={preset?.name ?? 'New workspace'}
	onClose={close}
	back={picked && !initial ? { label: 'Presets', onclick: () => pick(null) } : undefined}
	testid="new-workspace-sheet"
>
	{#if preset}
		{#if showDestDir}
			<MGroup
				title="Destination folder"
				footer={'Created under the workspace root. {destDir} in the command is replaced with it.'}
			>
				<input
					type="text"
					bind:value={destDir}
					placeholder="git.my-solution.1.0.0"
					aria-label="Destination folder"
					autocapitalize="off"
					autocomplete="off"
					spellcheck="false"
					class="block min-h-[52px] w-full border-none bg-transparent px-4 font-mono text-[16px] text-m-ink placeholder:text-m-dim focus:ring-0"
				/>
			</MGroup>
		{/if}
		{#if showCommand}
			<MGroup title="Command">
				<textarea
					bind:value={command}
					rows="3"
					aria-label="Command"
					autocapitalize="off"
					spellcheck="false"
					class="block w-full resize-none border-none bg-transparent px-4 py-3 font-mono text-[16px] text-m-ink focus:ring-0"
				></textarea>
			</MGroup>
		{/if}
		{#if runError}<p role="alert" class="mx-5 mb-3 text-[15px] text-m-stop">{runError}</p>{/if}
		<div class="px-4">
			<MButton onclick={() => void run()} disabled={!ready} testid="preset-run">
				{#if running}<Loader2 size={18} class="animate-spin" />{:else}<Play
						size={18}
						class="fill-current"
					/>{/if}Run in a terminal
			</MButton>
		</div>
	{:else}
		{#if loadError}
			<MBanner
				icon={TriangleAlert}
				tone="bg-m-stop/15 text-m-stop"
				title="Presets unavailable"
				detail={loadError}
				action="Retry"
				onAction={() => void loadPresets()}
			/>
		{/if}
		{#if choices.length}
			<MGroup title="Preset" footer="Each run opens its own terminal. Edit presets on the desktop.">
				{#each choices as item (item.id)}
					<MRow
						title={item.name}
						subtitle={item.command}
						onclick={() => pick(item)}
						chevron
						testid="bootstrap-preset"
					>
						{#snippet icon()}<Play size={17} />{/snippet}
					</MRow>
				{/each}
			</MGroup>
		{:else if loading}
			<p role="status" class="px-8 py-6 text-center text-[15px] text-m-dim">Reading presets…</p>
		{:else if !loadError}
			<p class="px-8 py-6 text-center text-[15px] text-m-dim">
				No presets. Add them on the desktop dashboard.
			</p>
		{/if}
		{#if manageLink}
			<MGroup>
				<MRow
					title="Dev Bootstrap"
					subtitle="Version, branch and updates"
					tone="bg-m-brain/15 text-m-brain"
					onclick={manage}
					chevron
					testid="manage-bootstrap"
				>
					{#snippet icon()}<Package size={18} />{/snippet}
				</MRow>
			</MGroup>
		{/if}
	{/if}
</MSheet>
