<script lang="ts">
	/**
	 * Network state on a devcontainer row. Each user-defined network is a chip with a menu.
	 * After a rebuild, a saved connection shows as a Reconnect chip. Without connections,
	 * a network that devcontainer.json declares shows as a Join suggestion.
	 */
	import { Loader2, Network, Plus, RefreshCw, Unplug } from 'lucide-svelte';
	import type { ContainerData } from '$lib/types';
	import { lastOctet, userNetworks } from '$lib/networkRules';
	import { networkMemory } from '$lib/networkMemory.svelte';
	import type { NetworkActions } from '$lib/networkActions.svelte';
	import RowMenu from './RowMenu.svelte';

	interface Props {
		container: ContainerData;
		actions: NetworkActions;
		onConnectNetwork?: (container: ContainerData, network?: string, seatIp?: string) => void;
	}
	let { container, actions, onConnectNetwork }: Props = $props();

	const running = $derived(container.state === 'running');
	const attached = $derived(userNetworks(container));
	const pending = $derived(running ? networkMemory.pending(container) : []);
	const suggestion = $derived(
		running && onConnectNetwork && attached.length === 0 && pending.length === 0
			? container.networkPresets?.[0]?.network
			: undefined
	);
	const chip =
		'flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50';
</script>

{#each attached as network (network.name)}
	{@const address = network.ip || network.configuredIp || ''}
	<RowMenu
		label={`Network ${network.name}: ${container.projectName}`}
		menuLabel={`Network ${network.name}`}
		title={address || 'No address while the container is stopped'}
		width={248}
		height={112}
		triggerClass="{chip} border-[#8fbcbb]/40 bg-[#8fbcbb]/15 text-[#4f8584] hover:bg-[#8fbcbb]/25 aria-expanded:bg-[#8fbcbb]/25 dark:text-[#8fbcbb]"
	>
		{#snippet trigger()}
			{#if actions.working === network.name}
				<Loader2 size={10} class="animate-spin" />
			{:else}
				<Network size={10} />
			{/if}
			<span class="font-mono">{network.name}</span>
			{#if network.aliases[0]}<span>as {network.aliases[0]}</span>{/if}
			{#if address}<span class="font-mono opacity-80">{lastOctet(address)}</span>{/if}
		{/snippet}
		{#snippet children(close: () => void)}
			<span class="menu-caption font-mono">{address || 'No address while stopped'}</span>
			<button
				role="menuitem"
				tabindex="-1"
				type="button"
				disabled={!running || !onConnectNetwork || Boolean(actions.working)}
				onclick={() => {
					close();
					onConnectNetwork?.(container, network.name);
				}}
			>
				<Network size={14} />Change address or alias…
			</button>
			<div class="menu-divider" role="separator"></div>
			<button
				role="menuitem"
				tabindex="-1"
				type="button"
				disabled={Boolean(actions.working)}
				onclick={() => {
					close();
					void actions.disconnect(network.name);
				}}
			>
				<Unplug size={14} />Disconnect from {network.name}
			</button>
		{/snippet}
	</RowMenu>
{/each}

{#each pending as saved (saved.network)}
	<button
		type="button"
		disabled={Boolean(actions.working)}
		title="A rebuild made a new container without this network"
		onclick={() => void actions.reconnect(saved)}
		class="{chip} border-[#ebcb8b]/50 bg-[#ebcb8b]/15 text-[#a07d2c] hover:bg-[#ebcb8b]/25 dark:text-[#ebcb8b]"
	>
		<RefreshCw size={10} class={actions.working === saved.network ? 'animate-spin' : ''} />
		Reconnect {saved.network}{saved.alias ? ` as ${saved.alias}` : ''}
	</button>
{/each}

{#if suggestion}
	<button
		type="button"
		title="devcontainer.json declares this network"
		onclick={() => onConnectNetwork?.(container, suggestion)}
		class="{chip} border-dashed border-[#8fbcbb]/60 text-[#4f8584] hover:bg-[#8fbcbb]/15 dark:text-[#8fbcbb]"
	>
		<Plus size={10} />Join {suggestion}
	</button>
{/if}
