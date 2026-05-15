<script lang="ts">
	import { X, Save, Play, ChevronDown } from 'lucide-svelte';
	import type { BootstrapPreset } from '$lib/types';

	interface Props {
		onClose: () => void;
		onRunInTerminal: (command: string, name: string) => void;
	}

	let { onClose, onRunInTerminal }: Props = $props();

	let presets = $state<BootstrapPreset[]>([]);
	let selectedPresetId = $state<string>('custom');
	let command = $state('');
	let savePromptVisible = $state(false);
	let savePresetName = $state('');
	let saving = $state(false);

	$effect(() => {
		fetch('/api/presets')
			.then((r) => r.json())
			.then((data) => (presets = data));
	});

	function onPresetChange(id: string) {
		selectedPresetId = id;
		if (id === 'custom') return;
		const preset = presets.find((p) => p.id === id);
		if (preset) command = preset.command;
	}

	function onCommandInput(val: string) {
		command = val;
		const match = presets.find((p) => p.command === val);
		selectedPresetId = match ? match.id : 'custom';
	}

	async function saveAsPreset() {
		if (!savePresetName.trim() || !command.trim()) return;
		saving = true;
		try {
			await fetch('/api/presets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: savePresetName.trim(), command })
			});
			const res = await fetch('/api/presets');
			presets = await res.json();
			const saved = presets.find((p) => p.command === command && p.name === savePresetName.trim());
			if (saved) selectedPresetId = saved.id;
			savePromptVisible = false;
			savePresetName = '';
		} finally {
			saving = false;
		}
	}

	function runInTerminal() {
		if (!command.trim()) return;
		const name = presets.find((p) => p.id === selectedPresetId)?.name ?? 'Bootstrap';
		onRunInTerminal(command.trim(), name);
		onClose();
	}
</script>

<!-- Backdrop -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
	role="dialog"
	aria-modal="true"
	aria-label="Run Bootstrap Script"
>
	<!-- Modal panel -->
	<div
		class="w-full max-w-md rounded-2xl bg-[#3b4252] border border-[#4c566a] shadow-2xl p-6 mx-4"
	>
		<!-- Header -->
		<div class="flex items-center justify-between mb-5">
			<h2 class="text-lg font-bold text-[#eceff4]">Run Bootstrap Script</h2>
			<button
				onclick={onClose}
				class="p-1.5 rounded-lg text-[#d8dee9]/60 hover:text-[#eceff4] hover:bg-[#4c566a] transition-colors"
				type="button"
				aria-label="Close"
			>
				<X size={18} />
			</button>
		</div>

		<!-- Execution Preset -->
		<label class="block mb-4">
			<span class="text-sm font-medium text-[#d8dee9] block mb-1.5">Execution Preset</span>
			<div class="relative">
				<select
					class="w-full appearance-none bg-[#2e3440] border border-[#4c566a] text-[#eceff4] rounded-lg px-3 py-2.5 pr-9 text-sm focus:outline-none focus:border-[#88c0d0]"
					value={selectedPresetId}
					onchange={(e) => onPresetChange((e.target as HTMLSelectElement).value)}
				>
					<option value="custom">Custom</option>
					{#each presets as preset (preset.id)}
						<option value={preset.id}>{preset.name}</option>
					{/each}
				</select>
				<ChevronDown
					size={16}
					class="absolute right-3 top-1/2 -translate-y-1/2 text-[#d8dee9]/60 pointer-events-none"
				/>
			</div>
		</label>

		<!-- Full Command -->
		<label class="block mb-4">
			<span class="text-sm font-medium text-[#d8dee9] block mb-1.5">Full Command</span>
			<input
				type="text"
				class="w-full bg-[#2e3440] border border-[#4c566a] text-[#a3be8c] font-mono rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-[#88c0d0] placeholder:text-[#4c566a]"
				placeholder="dev-bootstrap init git@github.com:org/repo.git --all"
				value={command}
				oninput={(e) => onCommandInput((e.target as HTMLInputElement).value)}
			/>
		</label>

		<!-- Save as Preset -->
		{#if savePromptVisible}
			<div class="flex gap-2 mb-4">
				<input
					type="text"
					class="flex-1 bg-[#2e3440] border border-[#4c566a] text-[#eceff4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#88c0d0] placeholder:text-[#4c566a]"
					placeholder="Preset name…"
					bind:value={savePresetName}
					onkeydown={(e) => e.key === 'Enter' && saveAsPreset()}
				/>
				<button
					onclick={saveAsPreset}
					disabled={saving || !savePresetName.trim()}
					class="px-4 py-2 rounded-lg bg-[#5e81ac] hover:bg-[#81a1c1] text-white text-sm font-medium transition-colors disabled:opacity-60"
					type="button"
				>
					{saving ? 'Saving…' : 'Save'}
				</button>
				<button
					onclick={() => (savePromptVisible = false)}
					class="px-3 py-2 rounded-lg text-[#d8dee9]/60 hover:bg-[#4c566a] transition-colors"
					type="button"
				>
					Cancel
				</button>
			</div>
		{/if}

		<!-- Footer actions -->
		<div class="flex items-center justify-between mt-2">
			<button
				onclick={() => (savePromptVisible = true)}
				disabled={!command.trim()}
				class="flex items-center gap-1.5 text-sm text-[#88c0d0] hover:text-[#81a1c1] disabled:opacity-40 disabled:cursor-default transition-colors"
				type="button"
			>
				<Save size={14} />
				Save as Preset
			</button>

			<button
				onclick={runInTerminal}
				disabled={!command.trim()}
				class="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#88c0d0] hover:bg-[#81a1c1] text-[#2e3440] font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-default"
				type="button"
			>
				<Play size={16} />
				Run in Terminal
			</button>
		</div>
	</div>
</div>
