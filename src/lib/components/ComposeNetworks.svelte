<script lang="ts">
	/**
	 * Networks of a Compose group in Docker Services. Each network shows its subnet, the
	 * devcontainers on it, and its node seats. A free seat offers Stand in; every network
	 * offers Connect devcontainer. Both open the network drawer with a running devcontainer.
	 */
	import { ChevronDown, Network } from 'lucide-svelte';
	import type { ContainerData, NetworkData } from '$lib/types';
	import { networkSeats, seatStatus } from '$lib/networkRules';
	import RowMenu from './RowMenu.svelte';

	interface Props {
		projectName: string;
		/** Networks that the Compose project created or has containers on */
		networks: NetworkData[];
		devcontainers: ContainerData[];
		onConnectNetwork: (container: ContainerData, network?: string, seatIp?: string) => void;
	}
	let { projectName, networks, devcontainers, onConnectNetwork }: Props = $props();

	const uid = $props.id();
	let selectedName = $state<string | null>(null);
	const selected = $derived(networks.find((entry) => entry.name === selectedName));
	const candidates = $derived(devcontainers.filter((container) => container.state === 'running'));
	const presets = $derived(devcontainers.flatMap((container) => container.networkPresets ?? []));
	const menuHeight = $derived(36 + 34 * Math.max(candidates.length, 1));
	const muted = 'text-[#4c566a] dark:text-[#d8dee9]/60';
	const menuTrigger =
		'flex items-center gap-1 rounded-lg border border-[#8fbcbb]/40 bg-[#8fbcbb]/10 px-2.5 py-1 text-xs font-semibold text-[#4f8584] hover:bg-[#8fbcbb]/20 aria-expanded:bg-[#8fbcbb]/20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#8fbcbb]';

	/** Devcontainers on a network, running or stopped. */
	const connected = (entry: NetworkData) =>
		entry.endpoints.filter((endpoint) => endpoint.isDevcontainer);
	const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
	const bareName = (container: ContainerData) => container.name.replace(/^\//, '');
</script>

{#snippet chooser(label: string, network: string, seatIp: string | undefined)}
	<RowMenu
		{label}
		menuLabel={`Running devcontainers for ${network}`}
		title={candidates.length ? undefined : 'Start a devcontainer first'}
		width={272}
		height={menuHeight}
		align="end"
		disabled={candidates.length === 0}
		triggerClass={menuTrigger}
	>
		{#snippet trigger()}
			{seatIp ? 'Stand in' : 'Connect devcontainer'}
			<ChevronDown size={12} />
		{/snippet}
		{#snippet children(close: () => void)}
			<span class="menu-caption">Running devcontainers</span>
			{#each candidates as container (container.id)}
				<button
					role="menuitem"
					tabindex="-1"
					type="button"
					onclick={() => {
						close();
						onConnectNetwork(container, network, seatIp);
					}}
				>
					<span class="menu-text">{container.projectName}</span>
					<span class="menu-hint font-mono">{bareName(container)}</span>
				</button>
			{/each}
		{/snippet}
	</RowMenu>
{/snippet}

<div class="border-b border-[#d8dee9]/60 px-5 py-3 dark:border-[#4c566a]/60">
	<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
		<span class="flex items-center gap-1.5 font-semibold text-[#2e3440] dark:text-[#eceff4]">
			<Network size={14} class="text-[#4f8584] dark:text-[#8fbcbb]" />Networks
		</span>
		<span class={muted}>Select a network to see its seats and connected devcontainers.</span>
	</div>
	<div class="mt-2 flex flex-wrap gap-2" role="group" aria-label={`Networks of ${projectName}`}>
		{#each networks as entry (entry.name)}
			{@const count = connected(entry).length}
			<button
				type="button"
				aria-pressed={entry.name === selectedName}
				aria-controls={entry.name === selectedName ? `${uid}-network` : undefined}
				onclick={() => (selectedName = selectedName === entry.name ? null : entry.name)}
				class="flex items-center gap-2 rounded-lg border px-2.5 py-1 text-xs transition-colors {entry.name ===
				selectedName
					? 'border-[#8fbcbb] bg-[#8fbcbb]/15 text-[#4f8584] dark:text-[#8fbcbb]'
					: 'border-[#d8dee9] text-[#2e3440] hover:border-[#8fbcbb] dark:border-[#4c566a] dark:text-[#eceff4]'}"
			>
				<span class="font-mono font-semibold">{entry.name}</span>
				<span class={muted}>{plural(count, 'devcontainer')}</span>
				<ChevronDown
					size={12}
					class="transition-transform {entry.name === selectedName ? 'rotate-180' : ''}"
				/>
			</button>
		{/each}
	</div>

	{#if selected}
		{@const network = selected}
		{@const members = connected(network)}
		{@const others = network.projects.filter((project) => project !== projectName)}
		<div
			id={`${uid}-network`}
			class="mt-3 grid gap-3 rounded-lg border border-[#d8dee9] bg-[#f0f4f8] p-3 text-xs dark:border-[#4c566a] dark:bg-[#2e3440]"
		>
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div class="grid gap-0.5">
					<span class="font-mono text-sm font-semibold text-[#4f8584] dark:text-[#8fbcbb]"
						>{network.name}</span
					>
					<span class={muted}
						>Subnet <span class="font-mono">{network.subnet ?? 'none (no static addresses)'}</span
						></span
					>
					{#if others.length}
						<span class={muted}>Also used by {others.join(', ')}</span>
					{/if}
				</div>
				{@render chooser(`Connect devcontainer to ${network.name}`, network.name, undefined)}
			</div>

			{#if members.length}
				<ul aria-label={`Devcontainers on ${network.name}`} class="grid gap-1">
					{#each members as member (member.containerId)}
						<li class="flex flex-wrap gap-x-3">
							<span class="font-mono font-semibold">{member.containerName}</span>
							<span class="font-mono {muted}">{member.ip || 'no address'}</span>
							{#if member.aliases[0]}<span class={muted}>as {member.aliases[0]}</span>{/if}
							{#if member.state !== 'running'}<span class={muted}>{member.state}</span>{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<p class={muted}>No devcontainers connected to this network.</p>
			{/if}

			{#if networkSeats(network, presets).length}
				<div class="grid gap-1.5">
					<span class="font-semibold"
						>Node seats <span class="font-normal {muted}">· Stand in takes a free seat</span></span
					>
					<ul aria-label={`Seats on ${network.name}`} class="grid gap-1.5">
						{#each networkSeats(network, presets) as seat (seat.ip)}
							{@const status = seatStatus(network, seat)}
							<li
								class="flex min-h-10 items-center gap-3 overflow-hidden rounded-md border border-l-4 border-[#d8dee9] bg-white pr-1 pl-3 dark:border-[#4c566a] dark:bg-[#3b4252] {status
									.holder?.isDevcontainer
									? 'border-l-[#81a1c1]'
									: status.free
										? 'border-l-[#4c566a]/50'
										: 'border-l-[#a3be8c]'}"
							>
								<span class="w-40 truncate font-mono font-semibold">{seat.hostname}</span>
								<span class="w-28 font-mono {muted}">{seat.ip}</span>
								<span class="min-w-0 flex-1 truncate {muted}">{status.text}</span>
								{#if status.free}
									{@render chooser(`Stand in for ${seat.hostname}`, network.name, seat.ip)}
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	{/if}
</div>
