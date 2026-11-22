<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		tone?: string;
		children: Snippet;
	}
	let { tone = 'text-m-dim border-m-edge', children }: Props = $props();
</script>

<span
	class="inline-flex h-6 max-w-full min-w-0 items-center rounded-full border px-2 font-mono text-[13px] whitespace-nowrap {tone}"
	data-testid="mobile-chip"
>
	<!-- Keep snippet icons inline: Tailwind's SVG reset otherwise puts the label on a second line. -->
	<span class="truncate leading-5 [&>svg]:mr-1 [&>svg]:inline-block [&>svg]:align-[-2px]">
		{@render children()}
	</span>
</span>
