<script lang="ts">
	import {
		X,
		Play,
		ChevronDown,
		Loader,
		SendToBack,
		Plus,
		Save,
		Trash2,
		Pencil
	} from 'lucide-svelte';
	import type { BootstrapPreset } from '$lib/types';
	import TerminalTab from './TerminalTab.svelte';

	interface Props {
		onClose: () => void;
		onRunBackground: (id: string, workspacePath: string, name: string) => void;
	}

	let { onClose, onRunBackground }: Props = $props();

	let presets = $state<BootstrapPreset[]>([]);
	let selectedPresetId = $state<string>('');
	let command = $state('');
	let destDir = $state('');
	let running = $state(false);
	let runError = $state<string | null>(null);
	// For interactive presets: session ID after bootstrap starts
	let interactiveSessionId = $state<string | null>(null);
	let interactiveWorkspacePath = $state<string | null>(null);
	let interactiveName = $state<string | null>(null);

	// Preset management state
	let editMode = $state<'idle' | 'new' | 'edit'>('idle');
	let presetName = $state('');
	let presetInteractive = $state(false);
	let fieldShowCommand = $state(true);
	let fieldShowDestDir = $state(true);
	let saving = $state(false);
	let confirmingDelete = $state(false);

	async function fetchPresets() {
		const r = await fetch('/api/presets');
		const data: BootstrapPreset[] = await r.json();
		presets = data;
		return data;
	}

	$effect(() => {
		fetchPresets().then((data) => {
			if (data.length > 0 && !selectedPresetId) {
				selectedPresetId = data[0].id;
				command = data[0].command;
			}
		});
	});

	const selectedPreset = $derived(presets.find((p) => p.id === selectedPresetId));

	// When a preset specifies 'fields', only those fields are visible.
	// Omitting 'fields' (or setting it to undefined) shows all fields.
	const showCommand = $derived(
		!selectedPreset?.fields || selectedPreset.fields.includes('command')
	);
	const showDestDir = $derived(
		!selectedPreset?.fields || selectedPreset.fields.includes('destDir')
	);

	function onPresetChange(id: string) {
		selectedPresetId = id;
		const preset = presets.find((p) => p.id === id);
		if (preset) {
			command = preset.command;
		}
	}

	function onCommandInput(val: string) {
		command = val;
		const match = presets.find((p) => p.command === val);
		if (match) selectedPresetId = match.id;
	}

	function startNew() {
		editMode = 'new';
		presetName = '';
		presetInteractive = false;
		fieldShowCommand = true;
		fieldShowDestDir = true;
		command = '';
		runError = null;
		confirmingDelete = false;
	}

	function startEdit() {
		if (!selectedPreset) return;
		editMode = 'edit';
		presetName = selectedPreset.name;
		presetInteractive = !!selectedPreset.interactive;
		fieldShowCommand = !selectedPreset.fields || selectedPreset.fields.includes('command');
		fieldShowDestDir = !selectedPreset.fields || selectedPreset.fields.includes('destDir');
		command = selectedPreset.command;
		runError = null;
		confirmingDelete = false;
	}

	function cancelEdit() {
		editMode = 'idle';
		presetName = '';
		runError = null;
		confirmingDelete = false;
		if (selectedPreset) {
			command = selectedPreset.command;
		}
	}

	async function savePreset() {
		if (!presetName.trim() || !command.trim() || saving) return;
		saving = true;
		runError = null;
		try {
			// Build fields array: omit when both are shown (default behavior)
			const fields: Array<'command' | 'destDir'> = [];
			if (fieldShowCommand) fields.push('command');
			if (fieldShowDestDir) fields.push('destDir');
			const body: Record<string, unknown> = {
				name: presetName.trim(),
				command: command.trim(),
				interactive: presetInteractive,
				fields: fieldShowCommand && fieldShowDestDir ? undefined : fields
			};
			if (editMode === 'edit' && selectedPreset) {
				body.id = selectedPreset.id;
			}
			const res = await fetch('/api/presets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				runError = await res.text();
				return;
			}
			const updated: BootstrapPreset[] = await res.json();
			presets = updated;
			// Select the newly saved preset
			const saved = updated.find((p) => p.name === presetName.trim());
			if (saved) {
				selectedPresetId = saved.id;
				command = saved.command;
			}
			editMode = 'idle';
			presetName = '';
		} catch (err) {
			runError = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	async function deletePreset() {
		if (!selectedPreset) return;
		saving = true;
		runError = null;
		try {
			const res = await fetch('/api/presets', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: selectedPreset.id })
			});
			if (!res.ok) {
				runError = await res.text();
				return;
			}
			const updated = await fetchPresets();
			confirmingDelete = false;
			if (updated.length > 0) {
				selectedPresetId = updated[0].id;
				command = updated[0].command;
			} else {
				selectedPresetId = '';
				command = '';
			}
		} catch (err) {
			runError = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	async function run() {
		if ((!command.trim() && showCommand) || (!destDir.trim() && showDestDir) || running) return;
		running = true;
		runError = null;
		const name = selectedPreset?.name ?? 'Bootstrap';
		const resolved = command.trim().replaceAll('{destDir}', destDir.trim());
		try {
			const res = await fetch('/api/bootstrap/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					command: resolved,
					name,
					// Send empty string when destDir is hidden; server generates a placeholder
					destDir: showDestDir ? destDir.trim() : ''
				})
			});
			if (!res.ok) {
				runError = await res.text();
				return;
			}
			const { id, workspacePath } = await res.json();
			if (selectedPreset?.interactive) {
				interactiveSessionId = id;
				interactiveWorkspacePath = workspacePath;
				interactiveName = name;
			} else {
				onRunBackground(id, workspacePath, name);
				onClose();
			}
		} catch (err) {
			runError = err instanceof Error ? err.message : String(err);
		} finally {
			running = false;
		}
	}

	function sendToBackground() {
		if (interactiveSessionId && interactiveWorkspacePath && interactiveName) {
			onRunBackground(interactiveSessionId, interactiveWorkspacePath, interactiveName);
		}
		onClose();
	}
</script>

<!-- Backdrop -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
	role="dialog"
	aria-modal="true"
	aria-label="Run Bootstrap Script"
>
	<!-- Modal panel -->
	<div
		class="mx-4 w-full rounded-2xl border border-[#4c566a] bg-[#3b4252] p-6 shadow-2xl {interactiveSessionId
			? 'max-w-5xl'
			: 'max-w-md'}"
	>
		<!-- Header -->
		<div class="mb-5 flex items-center justify-between">
			<h2 class="text-lg font-bold text-[#eceff4]">
				{interactiveSessionId ? 'Running Bootstrap' : 'Run Bootstrap Script'}
			</h2>
			{#if !interactiveSessionId}
				<button
					onclick={onClose}
					class="rounded-lg p-1.5 text-[#d8dee9]/60 transition-colors hover:bg-[#4c566a] hover:text-[#eceff4]"
					type="button"
					aria-label="Close"
				>
					<X size={18} />
				</button>
			{/if}
		</div>

		{#if interactiveSessionId}
			<!-- Interactive terminal view -->
			<div class="mb-5 h-[32rem] overflow-hidden rounded-lg border border-[#4c566a]">
				<TerminalTab sessionId={interactiveSessionId} active={true} fontSize={11} />
			</div>
			<div class="flex items-center justify-end">
				<button
					onclick={sendToBackground}
					class="flex items-center gap-2 rounded-xl bg-[#4c566a] px-5 py-2.5 text-sm font-semibold text-[#eceff4] transition-colors hover:bg-[#5e6c7e]"
					type="button"
				>
					<SendToBack size={16} />
					Send to Background
				</button>
			</div>
		{:else}
			<!-- Execution Preset -->
			<div class="mb-4">
				<div class="mb-1.5 flex items-center justify-between">
					<span class="text-sm font-medium text-[#d8dee9]">Execution Preset</span>
					<div class="flex items-center gap-1">
						{#if editMode === 'idle'}
							<button
								onclick={startNew}
								class="rounded-md p-1.5 text-[#d8dee9]/60 transition-colors hover:bg-[#4c566a] hover:text-[#88c0d0]"
								type="button"
								title="New preset"
							>
								<Plus size={14} />
							</button>
							<button
								onclick={startEdit}
								disabled={!selectedPreset}
								class="rounded-md p-1.5 text-[#d8dee9]/60 transition-colors hover:bg-[#4c566a] hover:text-[#ebcb8b] disabled:opacity-30 disabled:hover:bg-transparent"
								type="button"
								title="Edit preset"
							>
								<Pencil size={14} />
							</button>
							<button
								onclick={() => (confirmingDelete = true)}
								disabled={!selectedPreset}
								class="rounded-md p-1.5 text-[#d8dee9]/60 transition-colors hover:bg-[#4c566a] hover:text-[#bf616a] disabled:opacity-30 disabled:hover:bg-transparent"
								type="button"
								title="Delete preset"
							>
								<Trash2 size={14} />
							</button>
						{:else}
							<button
								onclick={cancelEdit}
								class="rounded-md px-2 py-1 text-xs text-[#d8dee9]/60 transition-colors hover:bg-[#4c566a] hover:text-[#eceff4]"
								type="button"
							>
								Cancel
							</button>
						{/if}
					</div>
				</div>

				{#if confirmingDelete}
					<div
						class="flex items-center gap-2 rounded-lg border border-[#bf616a]/40 bg-[#bf616a]/10 px-3 py-2.5 text-sm text-[#bf616a]"
					>
						<span>Delete "{selectedPreset?.name}"?</span>
						<button
							onclick={deletePreset}
							disabled={saving}
							class="ml-auto rounded-md bg-[#bf616a] px-2.5 py-1 text-xs font-semibold text-[#eceff4] transition-colors hover:bg-[#d08770]"
							type="button"
						>
							Confirm
						</button>
						<button
							onclick={() => (confirmingDelete = false)}
							class="rounded-md px-2.5 py-1 text-xs text-[#d8dee9]/60 transition-colors hover:text-[#eceff4]"
							type="button"
						>
							Cancel
						</button>
					</div>
				{:else if editMode !== 'idle'}
					<!-- Preset Name (shown in new/edit mode) -->
					<label class="mb-3 block">
						<span class="mb-1 block text-xs text-[#d8dee9]/70">Preset Name</span>
						<input
							type="text"
							class="w-full rounded-lg border border-[#4c566a] bg-[#2e3440] px-3 py-2.5 text-sm text-[#eceff4] placeholder:text-[#4c566a] focus:border-[#88c0d0] focus:outline-none"
							placeholder="My Bootstrap Preset"
							bind:value={presetName}
						/>
					</label>
					<!-- Interactive toggle -->
					<label class="mb-3 flex cursor-pointer items-center gap-2">
						<input
							type="checkbox"
							class="h-4 w-4 rounded border-[#4c566a] bg-[#2e3440] text-[#88c0d0] focus:ring-[#88c0d0]"
							bind:checked={presetInteractive}
						/>
						<span class="text-xs text-[#d8dee9]/70">Interactive (opens terminal in modal)</span>
					</label>
					<!-- Visible fields config -->
					<div class="mb-3">
						<span class="mb-1 block text-xs text-[#d8dee9]/70">Visible fields when running</span>
						<div class="flex items-center gap-4">
							<label class="flex cursor-pointer items-center gap-1.5">
								<input
									type="checkbox"
									class="h-3.5 w-3.5 rounded border-[#4c566a] bg-[#2e3440] text-[#88c0d0] focus:ring-[#88c0d0]"
									bind:checked={fieldShowCommand}
								/>
								<span class="text-xs text-[#d8dee9]/70">Command</span>
							</label>
							<label class="flex cursor-pointer items-center gap-1.5">
								<input
									type="checkbox"
									class="h-3.5 w-3.5 rounded border-[#4c566a] bg-[#2e3440] text-[#88c0d0] focus:ring-[#88c0d0]"
									bind:checked={fieldShowDestDir}
								/>
								<span class="text-xs text-[#d8dee9]/70">Destination Directory</span>
							</label>
						</div>
					</div>
				{:else}
					<div class="relative">
						<select
							class="w-full appearance-none rounded-lg border border-[#4c566a] bg-[#2e3440] px-3 py-2.5 pr-9 text-sm text-[#eceff4] focus:border-[#88c0d0] focus:outline-none"
							value={selectedPresetId}
							onchange={(e) => onPresetChange((e.target as HTMLSelectElement).value)}
						>
							{#each presets as preset (preset.id)}
								<option value={preset.id}>{preset.name}</option>
							{/each}
							{#if presets.length === 0}
								<option value="" disabled>No presets — click + to create one</option>
							{/if}
						</select>
						<ChevronDown
							size={16}
							class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[#d8dee9]/60"
						/>
					</div>
				{/if}
			</div>

			<!-- Full Command -->
			{#if showCommand || editMode !== 'idle'}
				<label class="mb-4 block">
					<span class="mb-1.5 block text-sm font-medium text-[#d8dee9]">Full Command</span>
					<input
						type="text"
						class="w-full rounded-lg border border-[#4c566a] bg-[#2e3440] px-3 py-2.5 font-mono text-sm text-[#a3be8c] placeholder:text-[#4c566a] focus:border-[#88c0d0] focus:outline-none"
						placeholder="dev-bootstrap init git@github.com:org/repo.git {'{destDir}'}"
						value={command}
						oninput={(e) => onCommandInput((e.target as HTMLInputElement).value)}
					/>
				</label>
			{/if}

			<!-- Destination Directory (only in run mode) -->
			{#if showDestDir && editMode === 'idle'}
				<label class="mb-4 block">
					<span class="mb-1.5 block text-sm font-medium text-[#d8dee9]">Destination Directory</span>
					<input
						type="text"
						class="w-full rounded-lg border border-[#4c566a] bg-[#2e3440] px-3 py-2.5 text-sm text-[#eceff4] placeholder:text-[#4c566a] focus:border-[#88c0d0] focus:outline-none"
						placeholder="my-project"
						bind:value={destDir}
					/>
					<span class="mt-1 block text-xs text-[#d8dee9]/50"
						>Replaces <code class="font-mono">{'{destDir}'}</code> in the command</span
					>
				</label>
			{/if}

			<!-- Error message -->
			{#if runError}
				<div
					class="mb-3 rounded-lg border border-[#bf616a]/40 bg-[#bf616a]/10 px-3 py-2.5 text-sm text-[#bf616a]"
				>
					{runError}
				</div>
			{/if}

			<!-- Footer actions -->
			<div class="mt-2 flex items-center justify-end gap-2">
				{#if editMode !== 'idle'}
					<button
						onclick={savePreset}
						disabled={!presetName.trim() || !command.trim() || saving}
						class="flex items-center gap-2 rounded-xl bg-[#a3be8c] px-5 py-2.5 text-sm font-semibold text-[#2e3440] transition-colors hover:bg-[#8fbcbb] disabled:cursor-default disabled:opacity-50"
						type="button"
					>
						{#if saving}
							<Loader size={16} class="animate-spin" />
						{:else}
							<Save size={16} />
						{/if}
						{editMode === 'new' ? 'Save Preset' : 'Update Preset'}
					</button>
				{:else}
					<button
						onclick={run}
						disabled={(!command.trim() && showCommand) ||
							(!destDir.trim() && showDestDir) ||
							running}
						class="flex items-center gap-2 rounded-xl bg-[#88c0d0] px-5 py-2.5 text-sm font-semibold text-[#2e3440] transition-colors hover:bg-[#81a1c1] disabled:cursor-default disabled:opacity-50"
						type="button"
					>
						{#if running}
							<Loader size={16} class="animate-spin" />
						{:else}
							<Play size={16} />
						{/if}
						Run
					</button>
				{/if}
			</div>
		{/if}
	</div>
</div>
