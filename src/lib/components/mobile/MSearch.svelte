<script lang="ts">
	import { Search, X } from 'lucide-svelte';

	interface Props {
		value: string;
		placeholder: string;
	}
	let { value = $bindable(), placeholder }: Props = $props();
</script>

<label class="mx-4 mb-3 flex min-h-11 items-center gap-2 rounded-xl bg-m-raised/70 px-3 text-m-dim">
	<Search size={17} aria-hidden="true" />
	<input
		type="search"
		bind:value
		{placeholder}
		aria-label={placeholder}
		autocapitalize="off"
		autocomplete="off"
		spellcheck="false"
		class="min-w-0 flex-1 border-none bg-transparent p-0 text-[16px] text-m-ink placeholder:text-m-dim focus:ring-0"
	/>
	{#if value}
		<button
			type="button"
			aria-label="Clear search"
			onclick={() => (value = '')}
			class="-mr-2 flex size-10 items-center justify-center"><X size={16} /></button
		>
	{/if}
</label>
