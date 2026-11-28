<script lang="ts">
	/** Declared endpoints of one service, with the container's address on its first network. */
	import { Copy } from 'lucide-svelte';
	import type { RowProps } from './types';

	let { view, container }: RowProps = $props();
	const endpoints = $derived(
		container.composeService
			? (view.kind.services?.[container.composeService]?.endpoints ?? [])
			: []
	);
	const address = $derived(container.networks?.find((network) => network.ip)?.ip ?? '');

	/** Copy an address for a harness or a client. */
	function copy(text: string) {
		void navigator.clipboard?.writeText(text).catch(() => {});
	}
</script>

{#if endpoints.length > 0}
	<div class="flex flex-wrap gap-1.5 pb-2 pl-12 text-xs" aria-label="Endpoints">
		{#each endpoints as endpoint (`${endpoint.label}:${endpoint.port}`)}
			{@const text = address ? `${address}:${endpoint.port}` : `:${endpoint.port}`}
			<button
				type="button"
				onclick={() => copy(text)}
				title={`Copy ${endpoint.protocol} address`}
				class="flex items-center gap-1 rounded-full border border-[#88c0d0]/30 bg-[#88c0d0]/10 px-2 py-0.5 font-medium text-[#5e81ac] dark:text-[#88c0d0]"
			>
				{endpoint.label}
				<code class="font-mono">{text}</code>
				<Copy size={10} />
			</button>
		{/each}
	</div>
{/if}
