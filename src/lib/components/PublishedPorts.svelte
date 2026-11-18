<script lang="ts">
	import type { PublishedPortBinding } from '$lib/types';
	import { displayAddress, foldBindings } from '$lib/publishedPorts';

	let { bindings = [] }: { bindings?: PublishedPortBinding[] } = $props();
	/** IPv4 and IPv6 bindings of one port share a line. */
	const ports = $derived(foldBindings(bindings));
	const anyWildcard = $derived(ports.some((port) => port.exposure === 'all'));
	/** Describe only what Docker reports, not firewall or network reachability. */
	const EXPOSURE = {
		all: 'All interfaces',
		loopback: 'Loopback only',
		specific: 'Specific interface',
		default: 'Default interface'
	};
</script>

{#if ports.length}
	<div class="grid gap-1 text-xs text-[#4c566a] dark:text-[#d8dee9]/70">
		<ul aria-label="Published bindings" class="grid gap-1">
			{#each ports as port (`${port.containerPort}/${port.protocol}/${port.hostPort}`)}
				<li class="flex flex-wrap gap-x-2">
					<span class="font-mono">
						{port.containerPort}/{port.protocol} →
						{port.addresses.map(displayAddress).join(' ')}:{port.hostPort}
					</span>
					<span>{EXPOSURE[port.exposure]}</span>
				</li>
			{/each}
		</ul>
		{#if anyWildcard}
			<p class="text-[#b48ead]">
				HTTPS proxying does not close these all-interface ports. Direct access still depends on your
				host firewall.
			</p>
		{/if}
	</div>
{/if}
