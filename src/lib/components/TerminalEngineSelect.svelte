<script lang="ts">
	import {
		TERMINAL_ENGINE_IDS,
		TERMINAL_ENGINES,
		isTerminalEngineId,
		type TerminalEngineId
	} from '$lib/terminalView';

	interface Props {
		/** Visible label of the native select. */
		label: string;
		value: TerminalEngineId;
		/** Tooltip that explains what the choice changes. */
		help?: string;
		onSelect: (engine: TerminalEngineId) => void;
	}
	let { label, value, help = '', onSelect }: Props = $props();
	const id = $props.id();

	/** Accept only known engine values from the native control. */
	function changed(event: Event & { currentTarget: HTMLSelectElement }) {
		const next = event.currentTarget.value;
		if (isTerminalEngineId(next)) onSelect(next);
	}
</script>

<label
	for={id}
	class="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-[#d8dee9]/70"
	title={help || TERMINAL_ENGINES[value].description}
>
	{label}
	<select
		{id}
		{value}
		onchange={changed}
		class="rounded border border-[#4c566a] bg-[#3b4252] py-0.5 pr-7 pl-2 text-[11px] text-[#eceff4]"
	>
		{#each TERMINAL_ENGINE_IDS as engine (engine)}
			<option value={engine}>{TERMINAL_ENGINES[engine].label}</option>
		{/each}
	</select>
</label>
