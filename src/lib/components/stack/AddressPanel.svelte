<script lang="ts">
	/** Copy current IPv4 addresses or see the configured address of a stopped container. */
	import { Copy } from 'lucide-svelte';
	import type { PresenterProps } from './types';
	import { nodeLabel } from './profileGroups';

	let { view, containers }: PresenterProps = $props();
	let message = $state('');
	const endpoints = $derived(
		containers
			.flatMap((container) =>
				(container.networks ?? []).flatMap((network) => {
					const address = network.ip || network.configuredIp;
					return address
						? [
								{
									id: `${container.id}:${network.name}`,
									label: nodeLabel(container),
									name: container.name,
									network: network.name,
									address,
									configured: !network.ip
								}
							]
						: [];
				})
			)
			.sort((a, b) => a.label.localeCompare(b.label) || a.network.localeCompare(b.network))
	);

	/** Copy one address and announce the result. */
	async function copy(address: string) {
		try {
			await navigator.clipboard.writeText(address);
			message = `Copied ${address}`;
		} catch {
			message = 'Could not copy the address';
		}
	}
</script>

{#if view.kind.panels?.includes('addresses')}
	<details class="border-t border-[#d8dee9]/60 px-5 py-3 text-sm dark:border-[#4c566a]/60">
		<summary class="cursor-pointer font-semibold"
			>Addresses <span class="font-normal">({endpoints.length})</span></summary
		>
		{#if endpoints.length}
			<ul class="mt-2 divide-y divide-[#d8dee9]/60 dark:divide-[#4c566a]/60">
				{#each endpoints as endpoint (endpoint.id)}
					<li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 [overflow-wrap:anywhere]">
						<span class="font-medium" title={endpoint.name}>{endpoint.label}</span>
						<span class="text-xs">{endpoint.network}</span>
						<button
							type="button"
							aria-label={`Copy ${endpoint.label} address ${endpoint.address}`}
							class="inline-flex items-center gap-2 rounded border border-[#d8dee9] px-2 py-0.5 font-mono text-xs dark:border-[#4c566a]"
							onclick={() => void copy(endpoint.address)}
							><Copy size={12} />{endpoint.address}</button
						>
						{#if endpoint.configured}<span class="text-xs">Configured, not active</span>{/if}
					</li>
				{/each}
			</ul>
			<p role="status" class="text-xs">{message}</p>
		{:else}
			<p class="mt-2 text-xs">No IPv4 addresses available.</p>
		{/if}
	</details>
{/if}
