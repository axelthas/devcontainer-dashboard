<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		tone?: string;
		children: Snippet;
	}
	let { tone = 'text-m-dim border-m-edge', children }: Props = $props();
</script>

<span
	class="inline-flex h-6 max-w-full items-center gap-1 rounded-full border px-2 font-mono text-[13px] whitespace-nowrap {tone}"
	><span class="truncate">{@render children()}</span></span
>
