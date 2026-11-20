<script lang="ts">
	/** A readable value with an explicit, keyboard-accessible copy action. */
	import { Check, Copy } from 'lucide-svelte';
	let { value, label }: { value: string; label: string } = $props();
	let copied = $state(false);
	let error = $state('');
	/** Copy the exact string. No inserted visual break is included in the clipboard value. */
	async function copy() {
		try {
			await navigator.clipboard.writeText(value);
			copied = true;
			error = '';
		} catch {
			error = 'Copy failed. Select the value and copy it manually.';
		}
	}
</script>

<div class="flex min-w-0 items-start gap-2">
	<span class="min-w-0 flex-1 font-mono break-all">{value}</span>
	<button
		type="button"
		aria-label={`Copy ${label}`}
		onclick={copy}
		class="flex size-11 shrink-0 items-center justify-center rounded-lg text-[#5e81ac] md:size-6 dark:text-[#88c0d0]"
	>
		{#if copied}<Check size={15} />{:else}<Copy size={15} />{/if}
	</button>
</div>
{#if error}<span role="alert" class="text-[#bf616a]">{error}</span>{/if}
