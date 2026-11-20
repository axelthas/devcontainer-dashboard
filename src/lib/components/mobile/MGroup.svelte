<script lang="ts">
	/** Inset grouped list, the iOS Settings pattern: one card with hairline separators. */
	import type { Snippet } from 'svelte';

	interface Props {
		title?: string;
		footer?: string;
		children: Snippet;
	}
	let { title, footer, children }: Props = $props();
</script>

<section class="mx-4 mb-6" aria-label={title}>
	{#if title}
		<h2 class="mb-1.5 px-4 text-[13px] font-semibold tracking-wide text-m-dim uppercase">
			{title}
		</h2>
	{/if}
	<div
		class="overflow-hidden rounded-[14px] bg-m-surface [&>*+*]:border-t [&>*+*]:border-m-edge/60"
	>
		{@render children()}
	</div>
	{#if footer}
		<p class="mt-1.5 px-4 text-[14px] leading-snug text-m-dim">{footer}</p>
	{/if}
</section>
