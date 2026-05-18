<script lang="ts">
	import { X, Play, ChevronDown } from 'lucide-svelte';
	import type { BootstrapPreset } from '$lib/types';

	interface Props {
		onClose: () => void;
		onRunInTerminal: (command: string, name: string) => void;
	}

	let { onClose, onRunInTerminal }: Props = $props();

	let presets = $state<BootstrapPreset[]>([]);
	let selectedPresetId = $state<string>('custom');
	let command = $state('');
	let destDir = $state('');

	$effect(() => {
		fetch('/api/presets')
			.then((r) => r.json())
			.then((data) => (presets = data));
	});

	function onPresetChange(id: string) {
		selectedPresetId = id;
		if (id === 'custom') return;
		const preset = presets.find((p) => p.id === id);
		if (preset) {
			command = preset.command;
		}
	}

	function onCommandInput(val: string) {
		command = val;
		const match = presets.find((p) => p.command === val);
		selectedPresetId = match ? match.id : 'custom';
	}

	function runInTerminal() {
		if (!command.trim()) return;
		const name = presets.find((p) => p.id === selectedPresetId)?.name ?? 'Bootstrap';
		const resolved = command.trim().replaceAll('{destDir}', destDir.trim());
		onRunInTerminal(resolved, name);
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
				placeholder="dev-bootstrap init git@github.com:org/repo.git {destDir}"
				value={command}
				oninput={(e) => onCommandInput((e.target as HTMLInputElement).value)}
			/>
		</label>

		<!-- Destination Directory -->
		<label class="block mb-4">
			<span class="text-sm font-medium text-[#d8dee9] block mb-1.5">Destination Directory</span>
			<input
				type="text"
				class="w-full bg-[#2e3440] border border-[#4c566a] text-[#eceff4] rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-[#88c0d0] placeholder:text-[#4c566a]"
				placeholder="my-project"
				bind:value={destDir}
			/>
			<span class="text-xs text-[#d8dee9]/50 mt-1 block">Replaces <code class="font-mono">{'{destDir}'}</code> in the command</span>
		</label>

		<!-- Footer actions -->
		<div class="flex items-center justify-end mt-2">
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
