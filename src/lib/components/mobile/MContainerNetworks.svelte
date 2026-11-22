<script lang="ts">
	/** Mobile network controls, with the same requests, rules and reconnect memory as desktop. */
	import { onMount } from 'svelte';
	import { Loader2, Network, Plus, RefreshCw, Unplug } from 'lucide-svelte';
	import type { ContainerData } from '$lib/types';
	import { userNetworks, type ConnectRequest, type NetworkChangeResult } from '$lib/networkRules';
	import { networkMemory, type SavedConnection } from '$lib/networkMemory.svelte';
	import { connectNetwork, disconnectNetwork, disconnectQuestion } from '$lib/networkClient';
	import { errorMessage, RequestError } from '$lib/requests';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';
	import MGroup from './MGroup.svelte';
	import MRow from './MRow.svelte';
	import MSheet from './MSheet.svelte';
	import MConfirm from './MConfirm.svelte';
	import MNetworkSheet from './MNetworkSheet.svelte';

	let { container }: { container: ContainerData } = $props();
	const dashboard = useMobileDashboard();
	const running = $derived(container.state === 'running');
	const attached = $derived(userNetworks(container));
	const pending = $derived(running ? networkMemory.pending(container) : []);
	const suggestion = $derived(
		running && !attached.length && !pending.length
			? container.networkPresets?.[0]?.network
			: undefined
	);
	let connect = $state<{ network?: string } | null>(null);
	let selected = $state<string | null>(null);
	let confirmDisconnect = $state(false);
	let working = $state('');
	let failure = $state('');
	let warning = $state('');
	const current = $derived(attached.find((entry) => entry.name === selected));

	onMount(() => networkMemory.load());

	/** Refresh network availability before choices; failed refreshes leave a visible warning. */
	function openConnect(network?: string) {
		selected = null;
		connect = { network };
		void dashboard.refreshNetworks();
	}

	/** Save only after a successful write, then refresh status without masking the write. */
	async function connected(target: ContainerData, request: ConnectRequest, remember: boolean) {
		failure = '';
		warning = '';
		const { network, ip, alias, setHostname } = request;
		if (remember) networkMemory.remember(target, { network, ip, alias, setHostname });
		else networkMemory.forget(target, network);
		if (request.onlyNetwork) {
			for (const entry of target.networks ?? [])
				if (entry.name !== network) networkMemory.forget(target, entry.name);
		}
		try {
			await dashboard.refreshContainers();
		} catch (cause) {
			warning = `The network changed, but status may be outdated. ${errorMessage(cause)}`;
		}
		await dashboard.refreshNetworks();
	}

	/** Show a partial hostname failure instead of claiming a complete reconnect. */
	function hostnameResult(result: NetworkChangeResult) {
		if (result.hostname?.status === 'failed')
			warning = `Connected. ${result.hostname.message ?? 'The hostname was not set.'}`;
	}

	/** A saved address can be occupied again. Open choices on conflict, without retrying. */
	async function reconnect(saved: SavedConnection) {
		if (working) return;
		const target = container;
		working = saved.network;
		failure = '';
		warning = '';
		const request: ConnectRequest = {
			network: saved.network,
			ip: saved.ip,
			alias: saved.alias,
			onlyNetwork: false,
			setHostname: saved.setHostname && Boolean(saved.alias)
		};
		try {
			const result = await connectNetwork(target.id, request);
			await connected(target, request, true);
			hostnameResult(result);
		} catch (cause) {
			failure = errorMessage(cause);
			if (cause instanceof RequestError && cause.status === 409) openConnect(saved.network);
		} finally {
			working = '';
		}
	}

	/** Confirmed disconnect; the server plans a bridge fallback when this is the last network. */
	async function disconnect() {
		if (!selected || working) return;
		const target = container;
		const network = selected;
		working = network;
		failure = '';
		warning = '';
		try {
			await disconnectNetwork(target.id, network);
			networkMemory.forget(target, network);
			selected = null;
			confirmDisconnect = false;
			try {
				await dashboard.refreshContainers();
			} catch (cause) {
				warning = `Disconnected, but status may be outdated. ${errorMessage(cause)}`;
			}
			await dashboard.refreshNetworks();
		} catch (cause) {
			failure = errorMessage(cause);
		} finally {
			working = '';
		}
	}
</script>

<MGroup
	title="Networks"
	footer={!running ? 'Start the container to connect it to a network.' : undefined}
>
	{#each attached as network (network.name)}
		<MRow
			title={network.name}
			subtitle={[
				network.ip || network.configuredIp || (running ? 'No address' : 'No address while stopped'),
				...network.aliases
			]
				.filter(Boolean)
				.join(' · ')}
			mono
			tone="bg-m-run/15 text-m-run"
			onclick={() => {
				selected = network.name;
				confirmDisconnect = false;
				failure = '';
			}}
			disabled={Boolean(working)}
			chevron
			testid="attached-network"
		>
			{#snippet icon()}{#if working === network.name}<Loader2
						size={18}
						class="animate-spin"
					/>{:else}<Network size={18} />{/if}{/snippet}
		</MRow>
	{/each}
	{#each pending as saved (saved.network)}
		<MRow
			title={`Reconnect ${saved.network}`}
			subtitle={`The rebuild made a new container${saved.alias ? `. Rejoin as ${saved.alias}` : ''}`}
			tone="bg-m-warn/15 text-m-warn"
			onclick={() => void reconnect(saved)}
			disabled={Boolean(working)}
			testid="network-reconnect"
		>
			{#snippet icon()}<RefreshCw
					size={18}
					class={working === saved.network ? 'animate-spin' : ''}
				/>{/snippet}
		</MRow>
	{/each}
	{#if suggestion}<MRow
			title={`Join ${suggestion}`}
			subtitle="devcontainer.json declares it"
			onclick={() => openConnect(suggestion)}
			disabled={Boolean(working)}
			chevron
			testid="network-join">{#snippet icon()}<Plus size={18} />{/snippet}</MRow
		>{/if}
	<MRow
		title="Connect to a network…"
		onclick={() => openConnect()}
		disabled={!running || Boolean(working)}
		testid="network-connect">{#snippet icon()}<Network size={18} />{/snippet}</MRow
	>
</MGroup>
{#if failure && !selected}<p role="alert" class="mx-5 mb-5 text-[15px] text-m-stop">
		{failure}
	</p>{/if}
{#if warning}<p role="status" class="mx-5 mb-5 text-[15px] text-m-warn">{warning}</p>{/if}

<MNetworkSheet
	container={connect ? container : null}
	network={connect?.network}
	networks={dashboard.networks}
	networksError={dashboard.networkError}
	onClose={() => (connect = null)}
	onConnected={connected}
/>
<MSheet
	open={Boolean(selected)}
	title={selected ?? 'Network'}
	onClose={() => {
		if (!working) selected = null;
	}}
	closeDisabled={Boolean(working)}
	testid="network-actions-sheet"
>
	{#if selected}
		{#if confirmDisconnect}
			<MConfirm
				title={`Disconnect from ${selected}?`}
				body={disconnectQuestion(container, selected)}
				action="Disconnect"
				busy={Boolean(working)}
				error={failure}
				onConfirm={() => void disconnect()}
				onCancel={() => {
					if (!working) confirmDisconnect = false;
				}}
			/>
		{:else}
			<p class="px-5 pb-3 font-mono text-[14px] [overflow-wrap:anywhere] text-m-dim">
				{[current?.ip || current?.configuredIp, ...(current?.aliases ?? [])]
					.filter(Boolean)
					.join(' · ') || 'No address while stopped'}
			</p>
			<MGroup>
				<MRow
					title="Change address or alias…"
					onclick={() => openConnect(selected ?? undefined)}
					disabled={!running}
					chevron>{#snippet icon()}<Network size={18} />{/snippet}</MRow
				>
				<MRow title="Disconnect…" danger onclick={() => (confirmDisconnect = true)}
					>{#snippet icon()}<Unplug size={18} />{/snippet}</MRow
				>
			</MGroup>
		{/if}
	{/if}
</MSheet>
