<script lang="ts">
	/** A detail value that wraps fully and copies the exact string. */
	import { Check, Copy } from 'lucide-svelte';

	interface Props {
		label: string;
		value: string;
	}
	let { label, value }: Props = $props();
	let copied = $state(false);
	let failed = $state(false);

	/** The clipboard API needs a secure context; a failure leaves the value selectable. */
	async function copy() {
		try {
			await navigator.clipboard.writeText(value);
			copied = true;
			failed = false;
		} catch {
			failed = true;
		}
		setTimeout(() => {
			copied = false;
			failed = false;
		}, 1500);
	}
</script>

<div class="flex items-start gap-2 py-2.5 pr-1 pl-4">
	<div class="min-w-0 flex-1">
		<div class="text-[14px] text-m-dim">{failed ? 'Copy failed: select the text' : label}</div>
		<div class="mt-0.5 font-mono text-[14.5px] leading-snug [overflow-wrap:anywhere] select-all">
			{value}
		</div>
	</div>
	<button
		type="button"
		aria-label={`Copy ${label}`}
		onclick={copy}
		class="flex size-11 shrink-0 items-center justify-center rounded-full text-m-frost active:bg-m-raised"
	>
		{#if copied}<Check size={18} class="text-m-run" />{:else}<Copy size={18} />{/if}
	</button>
</div>
