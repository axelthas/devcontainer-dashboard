<script lang="ts">
	import type { PublishedPortBinding } from '$lib/types';

	let { bindings = [] }: { bindings?: PublishedPortBinding[] } = $props();
	const hasWildcard = $derived(
		bindings.some((binding) => ['0.0.0.0', '::'].includes(binding.hostIp))
	);

	/** Describe only what Docker reports, not firewall or network reachability. */
	function exposure(address: string): string {
		if (['0.0.0.0', '::'].includes(address)) return 'All interfaces';
		if (['127.0.0.1', '::1'].includes(address)) return 'Loopback only';
		return address ? 'Specific interface' : 'Default interface';
	}
</script>

{#if bindings.length}
	<div class="grid gap-1 text-xs text-[#4c566a] dark:text-[#d8dee9]/70">
		<ul aria-label="Published bindings" class="grid gap-1">
			{#each bindings as binding, index (`${binding.containerPort}/${binding.protocol}/${binding.hostIp}/${binding.hostPort}/${index}`)}
				<li class="flex flex-wrap gap-x-2">
					<span class="font-mono">
						{binding.containerPort}/{binding.protocol} →
						{binding.hostIp.includes(':')
							? `[${binding.hostIp}]`
							: binding.hostIp || '*'}:{binding.hostPort}
					</span>
					<span>{exposure(binding.hostIp)}</span>
				</li>
			{/each}
		</ul>
		{#if hasWildcard}
			<p class="text-[#b48ead]">
				HTTPS proxying does not close these all-interface ports. Direct access still depends on your
				host firewall.
			</p>
		{/if}
	</div>
{/if}
