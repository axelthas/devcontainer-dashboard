<script lang="ts">
	import { X, Play, ChevronDown, Loader, SendToBack } from 'lucide-svelte';
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
	// For interactive presets: session ID after bootstrap starts
	let interactiveSessionId = $state<string | null>(null);
	let interactiveWorkspacePath = $state<string | null>(null);
	let interactiveName = $state<string | null>(null);

	$effect(() => {
		fetch('/api/presets')
			.then((r) => r.json())
			.then((data: BootstrapPreset[]) => {
				presets = data;
				if (data.length > 0 && !selectedPresetId) {
					selectedPresetId = data[0].id;
					command = data[0].command;
				}
			});
	});

	const selectedPreset = $derived(presets.find((p) => p.id === selectedPresetId));

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

	async function run() {
		if (!command.trim() || !destDir.trim() || running) return;
		running = true;
		const name = selectedPreset?.name ?? 'Bootstrap';
		const resolved = command.trim().replaceAll('{destDir}', destDir.trim());
		try {
			const res = await fetch('/api/bootstrap/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ command: resolved, name, destDir: destDir.trim() })
			});
			if (!res.ok) throw new Error(await res.text());
			const { id, workspacePath } = await res.json();
			if (selectedPreset?.interactive) {
				interactiveSessionId = id;
				interactiveWorkspacePath = workspacePath;
				interactiveName = name;
			} else {
				onRunBackground(id, workspacePath, name);
				onClose();
			}
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
			<div class="mb-5 h-96 overflow-hidden rounded-lg border border-[#4c566a]">
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
			<label class="mb-4 block">
				<span class="mb-1.5 block text-sm font-medium text-[#d8dee9]">Execution Preset</span>
				<div class="relative">
					<select
						class="w-full appearance-none rounded-lg border border-[#4c566a] bg-[#2e3440] px-3 py-2.5 pr-9 text-sm text-[#eceff4] focus:border-[#88c0d0] focus:outline-none"
						value={selectedPresetId}
						onchange={(e) => onPresetChange((e.target as HTMLSelectElement).value)}
					>
						{#each presets as preset (preset.id)}
							<option value={preset.id}>{preset.name}</option>
						{/each}
					</select>
					<ChevronDown
						size={16}
						class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[#d8dee9]/60"
					/>
				</div>
			</label>

			<!-- Full Command -->
			<label class="mb-4 block">
				<span class="mb-1.5 block text-sm font-medium text-[#d8dee9]">Full Command</span>
				<input
					type="text"
					class="w-full rounded-lg border border-[#4c566a] bg-[#2e3440] px-3 py-2.5 font-mono text-sm text-[#a3be8c] placeholder:text-[#4c566a] focus:border-[#88c0d0] focus:outline-none"
					placeholder="dev-bootstrap init git@github.com:org/repo.git {destDir}"
					value={command}
					oninput={(e) => onCommandInput((e.target as HTMLInputElement).value)}
				/>
			</label>

			<!-- Destination Directory -->
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

			<!-- Footer actions -->
			<div class="mt-2 flex items-center justify-end">
				<button
					onclick={run}
					disabled={!command.trim() || !destDir.trim() || running}
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
			</div>
		{/if}
	</div>
</div>
