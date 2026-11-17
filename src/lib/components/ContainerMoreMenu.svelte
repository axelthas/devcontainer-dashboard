<script lang="ts">
	import {
		Ellipsis,
		Hammer,
		Loader2,
		Network,
		Play,
		RotateCw,
		Square,
		Trash2,
		Unplug
	} from 'lucide-svelte';
	import type { ContainerData } from '$lib/types';
	import type { ContainerActions } from '$lib/containerActions.svelte';
	import { userNetworks } from '$lib/networkRules';
	import RowMenu from './RowMenu.svelte';

	interface Props {
		container: ContainerData;
		/** Shared with the row, so the row can show progress and errors. */
		actions: ContainerActions;
		/** Open the network drawer. Without it, the menu has no network group. */
		onConnectNetwork?: () => void;
		onDisconnectNetwork?: (network: string) => void;
	}
	let { container, actions, onConnectNetwork, onDisconnectNetwork }: Props = $props();

	const running = $derived(container.state === 'running');
	const containerName = $derived(container.name.replace(/^\//, ''));
	/** Networks above lifecycle: they change wiring, not the container. */
	const networks = $derived(onConnectNetwork ? userNetworks(container) : []);
	const networkItems = $derived(onConnectNetwork ? 1 + (onDisconnectNetwork ? networks.length : 0) : 0);
	const menuHeight = $derived((running ? 188 : 156) + (networkItems ? networkItems * 32 + 9 : 0));

	/** Close first, so a confirmation dialog never sits behind the menu. */
	function run(close: () => void, work: () => Promise<void>) {
		close();
		void work();
	}
</script>

<RowMenu
	label={`Container actions: ${container.projectName}`}
	menuLabel={`Actions for ${container.projectName}`}
	title="Container actions"
	width={networkItems ? 264 : 216}
	height={menuHeight}
	align="end"
	triggerClass="flex h-7 w-7 items-center justify-center rounded-lg text-[#4c566a] hover:bg-[#e5e9f0] aria-expanded:bg-[#e5e9f0] dark:text-[#d8dee9] dark:hover:bg-[#434c5e] dark:aria-expanded:bg-[#434c5e]"
>
	{#snippet trigger()}
		{#if actions.busy}
			<Loader2 size={15} class="animate-spin" />
		{:else}
			<Ellipsis size={16} />
		{/if}
	{/snippet}
	{#snippet children(close: () => void)}
		<span class="menu-caption font-mono">{containerName}</span>
		{#if onConnectNetwork}
			<button
				role="menuitem"
				tabindex="-1"
				type="button"
				disabled={actions.busy || !running}
				title={running ? undefined : 'Start the container first'}
				onclick={() => {
					close();
					onConnectNetwork?.();
				}}
			>
				<Network size={14} /><span class="menu-text">Connect to network…</span>
				{#if !running}<span class="menu-hint">start first</span>{/if}
			</button>
			{#if onDisconnectNetwork}
				{#each networks as network (network.name)}
					<button
						role="menuitem"
						tabindex="-1"
						type="button"
						disabled={actions.busy}
						onclick={() => {
							close();
							onDisconnectNetwork?.(network.name);
						}}
					>
						<Unplug size={14} /><span class="menu-text truncate">Disconnect from {network.name}</span>
					</button>
				{/each}
			{/if}
			<div class="menu-divider" role="separator"></div>
		{/if}
		{#if running}
			<button
				role="menuitem"
				tabindex="-1"
				type="button"
				disabled={actions.busy}
				onclick={() => run(close, () => actions.run('restart'))}
			>
				<RotateCw size={14} />Restart
			</button>
			<button
				role="menuitem"
				tabindex="-1"
				type="button"
				disabled={actions.busy}
				onclick={() => run(close, () => actions.run('stop'))}
			>
				<Square size={14} />Stop
			</button>
		{:else}
			<button
				role="menuitem"
				tabindex="-1"
				type="button"
				disabled={actions.busy}
				onclick={() => run(close, () => actions.run('start'))}
			>
				<Play size={14} />Start
			</button>
		{/if}
		<button
			role="menuitem"
			tabindex="-1"
			type="button"
			disabled={actions.busy || !actions.canRebuild}
			title={actions.canRebuild
				? 'Rebuild and restart'
				: 'Rebuild unavailable: workspace or exact configuration label is missing'}
			onclick={() => run(close, () => actions.rebuild())}
		>
			<Hammer size={14} />Rebuild and restart…
		</button>
		<div class="menu-divider" role="separator"></div>
		<button
			role="menuitem"
			tabindex="-1"
			type="button"
			class="menu-danger"
			disabled={actions.busy}
			onclick={() => run(close, () => actions.run('delete'))}
		>
			<Trash2 size={14} />Delete container…
		</button>
	{/snippet}
</RowMenu>
