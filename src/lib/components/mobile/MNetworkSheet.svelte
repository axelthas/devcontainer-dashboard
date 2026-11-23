<script lang="ts">
	/**
	 * Drawer that connects a running devcontainer to an existing Docker network.
	 * Three choices, top to bottom: the network, who to be on it, and how to wire it.
	 * The exact Docker calls print below the form before anything runs.
	 */
	import { untrack } from 'svelte';
	import { Loader2, Network } from 'lucide-svelte';
	import type { ContainerData, NetworkData } from '$lib/types';
	import {
		addressProblem,
		HOSTNAME_PATTERN,
		hostnameCommand,
		networkSeats,
		planConnect,
		seatStatus,
		stepCommand,
		userNetworks,
		type ConnectRequest
	} from '$lib/networkRules';
	import { connectNetwork } from '$lib/networkClient';
	import { connectionIdentity } from '$lib/networkMemory.svelte';
	import MSheet from './MSheet.svelte';
	import MButton from './MButton.svelte';
	import { errorMessage } from '$lib/requests';

	interface Props {
		/** The container to connect. Null closes the drawer. */
		container: ContainerData | null;
		/** Network and seat to preselect */
		network?: string;
		seatIp?: string;
		networks: NetworkData[];
		/** Shown when the network list could not be refreshed */
		networksError?: string;
		onClose: () => void;
		/** Called after a successful connect, before the drawer closes */
		onConnected: (
			container: ContainerData,
			request: ConnectRequest,
			remember: boolean
		) => Promise<void>;
	}
	let {
		container,
		network: initialNetwork,
		seatIp: initialSeat,
		networks,
		networksError = '',
		onClose,
		onConnected
	}: Props = $props();

	type Mode = 'seat' | 'auto' | 'custom';
	interface Plan {
		request?: ConnectRequest;
		error?: string;
		ipError?: string;
		aliasError?: string;
	}

	const uid = $props.id();
	let networkName = $state('');
	let mode = $state<Mode>('auto');
	let seatIp = $state('');
	let customIp = $state('');
	let customAlias = $state('');
	let onlyNetwork = $state(false);
	let setHostname = $state(true);
	let remember = $state(true);
	let busy = $state(false);
	let failure = $state('');
	let hostnameWarning = $state('');

	/** Sandbox networks (owned by a Compose project) first, then the rest, each by name. */
	const sortedNetworks = $derived([
		...networks.filter((entry) => entry.projects.length > 0),
		...networks.filter((entry) => entry.projects.length === 0)
	]);
	const selected = $derived(networks.find((entry) => entry.name === networkName));
	const seats = $derived(selected ? networkSeats(selected, container?.networkPresets) : []);
	const attached = $derived(container ? userNetworks(container) : []);
	const containerName = $derived(container?.name.replace(/^\//, '') ?? '');
	/** Opening on another container, network, or seat resets the form; polling does not. */
	const openKey = $derived(
		container ? `${container.id}|${initialNetwork ?? ''}|${initialSeat ?? ''}` : ''
	);
	const plan = $derived(buildPlan());
	const commands = $derived(
		container && plan.request
			? [
					...planConnect(container.networks ?? [], plan.request).map((step) =>
						stepCommand(step, container.name)
					),
					...(plan.request.setHostname && plan.request.alias
						? [hostnameCommand(container.name, plan.request.alias)]
						: [])
				]
			: []
	);
	const leaving = $derived(
		(container?.networks ?? []).map((entry) => entry.name).filter((name) => name !== networkName)
	);
	const aliasForHostname = $derived(
		mode === 'seat' ? seats.find((seat) => seat.ip === seatIp)?.hostname : customAlias
	);

	$effect(() => {
		if (!openKey) return;
		untrack(reset);
	});

	// The network list may arrive after the drawer opens.
	$effect(() => {
		if (container && !networkName && sortedNetworks.length > 0)
			untrack(() => selectNetwork(sortedNetworks[0].name));
	});

	/** The seat to preselect on a network: the requested one, the current one, or a declared one. */
	function preferredSeat(name: string): string {
		const entry = networks.find((candidate) => candidate.name === name);
		if (!entry || !container) return '';
		const free = networkSeats(entry, container.networkPresets).filter(
			(seat) => seatStatus(entry, seat, container.id).free
		);
		const wanted = [
			name === initialNetwork ? initialSeat : undefined,
			attached.find((current) => current.name === name)?.ip,
			container.networkPresets?.find((preset) => preset.network === name)?.seats[0]?.ip
		];
		return wanted.find((ip) => ip && free.some((seat) => seat.ip === ip)) ?? '';
	}

	/** Select a network and its preferred seat. */
	function selectNetwork(name: string) {
		networkName = name;
		seatIp = preferredSeat(name);
		if (seatIp) mode = 'seat';
		else if (mode === 'seat') mode = 'auto';
	}

	/** Start a fresh form for a new target. The shared sheet handles focus. */
	function reset() {
		if (!container) return;
		customIp = '';
		customAlias = '';
		onlyNetwork = false;
		setHostname = true;
		remember = connectionIdentity(container) !== null;
		busy = false;
		failure = '';
		hostnameWarning = '';
		mode = 'auto';
		const first =
			initialNetwork ??
			attached[0]?.name ??
			container.networkPresets?.[0]?.network ??
			sortedNetworks[0]?.name ??
			'';
		networkName = '';
		if (first) selectNetwork(first);
	}

	/** Turn the form into a request, or say what blocks it. */
	function buildPlan(): Plan {
		if (!container) return { error: 'No container selected' };
		if (container.state !== 'running')
			return { error: 'Start the container before you connect it to a network' };
		if (!selected)
			return {
				error: networks.length
					? 'Choose a network'
					: 'No user-defined networks found. The dashboard does not create networks.'
			};
		const base: ConnectRequest = { network: selected.name, onlyNetwork, setHostname: false };
		if (mode === 'auto') return { request: base };
		if (mode === 'seat') {
			const seat = seats.find((entry) => entry.ip === seatIp);
			if (!seat || !seatStatus(selected, seat, container.id).free)
				return { error: 'Choose a free seat' };
			const problem = addressProblem(selected, seat.ip, container.id);
			if (problem) return { error: `${seat.ip}: ${problem}` };
			const alias = HOSTNAME_PATTERN.test(seat.hostname) ? seat.hostname : undefined;
			return {
				request: { ...base, ip: seat.ip, ...(alias ? { alias, setHostname } : {}) }
			};
		}
		const ipError = customIp
			? (addressProblem(selected, customIp, container.id) ?? undefined)
			: undefined;
		const aliasError =
			customAlias && !HOSTNAME_PATTERN.test(customAlias)
				? 'Use a lowercase hostname: letters, digits, hyphens, and dots'
				: undefined;
		if (ipError || aliasError) return { ipError, aliasError, error: ipError ?? aliasError };
		return {
			request: {
				...base,
				...(customIp ? { ip: customIp } : {}),
				...(customAlias ? { alias: customAlias, setHostname } : {})
			}
		};
	}

	/** One line about a network: its sandbox, node count, and subnet. */
	function summary(entry: NetworkData): string {
		const nodes = entry.endpoints.filter((endpoint) => !endpoint.isDevcontainer);
		const running = nodes.filter((endpoint) => endpoint.state === 'running').length;
		const owner = entry.projects.length
			? `Compose ${entry.projects.join(', ')} · ${running} of ${nodes.length} running`
			: 'No Compose project';
		return `${owner} · ${entry.subnet ?? 'no IPv4 subnet'}`;
	}

	/** Connect, report the hostname result, and close only when nothing needs attention. */
	async function submit() {
		const request = plan.request;
		if (!container || !request || busy) return;
		const current = container;
		busy = true;
		failure = '';
		hostnameWarning = '';
		try {
			const result = await connectNetwork(current.id, request);
			await onConnected(current, request, remember);
			if (result.hostname?.status === 'failed')
				hostnameWarning = result.hostname.message ?? 'The hostname was not set.';
			else onClose();
		} catch (cause) {
			failure = errorMessage(cause);
		} finally {
			busy = false;
		}
	}

	/** Close unless a request runs; a lost response must not hide accepted work. */
	function close() {
		if (!busy) onClose();
	}

	const MODES: [Mode, string][] = [
		['seat', 'A node'],
		['auto', 'Any address'],
		['custom', 'Custom']
	];
</script>

<MSheet
	open={Boolean(container)}
	title="Connect to a network"
	onClose={close}
	closeDisabled={busy}
	testid="network-connect-sheet"
>
	{#if container}
		<p class="px-5 pb-2 font-mono text-[14px] [overflow-wrap:anywhere] text-m-dim">
			{container.projectName} · {containerName}
		</p>
		<div class="grid gap-5 px-4">
			<fieldset disabled={busy}>
				<legend class="mb-2 text-[14px] font-semibold text-m-dim">Network</legend>
				{#if networksError}<p role="alert" class="mb-2 text-[14px] text-m-stop">
						{networksError}
					</p>{/if}
				{#if sortedNetworks.length === 0}
					<p class="text-[15px] text-m-dim">
						No user-defined networks found. Start the sandbox first. DevHarbour does not create
						networks.
					</p>
				{/if}
				<div class="grid gap-2">
					{#each sortedNetworks as entry (entry.name)}
						<label
							class="flex min-h-14 items-start gap-3 rounded-[14px] border p-3 {entry.name ===
							networkName
								? 'border-m-frost bg-m-frost/10'
								: 'border-m-edge bg-m-surface'}"
						>
							<input
								type="radio"
								name={`${uid}-network`}
								value={entry.name}
								checked={entry.name === networkName}
								onchange={() => selectNetwork(entry.name)}
								class="mt-1 size-5 shrink-0 accent-m-frost"
							/>
							<span class="grid min-w-0 gap-1">
								<span class="font-mono text-[15px] font-semibold [overflow-wrap:anywhere]"
									>{entry.name}</span
								>
								<span class="text-[14px] leading-snug text-m-dim">{summary(entry)}</span>
								{#if container.networkPresets?.some((preset) => preset.network === entry.name)}<span
										class="text-[14px] text-m-frost">devcontainer.json</span
									>{/if}
								{#if attached.some((current) => current.name === entry.name)}<span
										class="text-[14px] text-m-run">Connected</span
									>{/if}
							</span>
						</label>
					{/each}
				</div>
			</fieldset>

			{#if selected}
				<fieldset disabled={busy}>
					<legend class="mb-2 text-[14px] font-semibold text-m-dim">Join as</legend>
					<div
						class="grid grid-cols-3 gap-1 rounded-[14px] bg-m-raised p-1"
						role="radiogroup"
						aria-label="Join as"
					>
						{#each MODES as [value, label] (value)}
							<label
								class="flex min-h-11 cursor-pointer items-center justify-center rounded-[10px] px-1 text-center text-[14px] font-semibold has-[:disabled]:opacity-40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-m-frost {mode ===
								value
									? 'bg-m-screen text-m-ink'
									: 'text-m-dim'}"
							>
								<input
									type="radio"
									name={`${uid}-mode`}
									{value}
									checked={mode === value}
									disabled={value === 'seat' && seats.length === 0}
									onchange={() => (mode = value)}
									class="sr-only"
								/>
								{label}
							</label>
						{/each}
					</div>
					{#if mode === 'seat'}
						<div class="mt-2 grid gap-2" role="radiogroup" aria-label={`Seats on ${selected.name}`}>
							{#each seats as seat (seat.ip)}
								{@const status = seatStatus(selected, seat, container.id)}
								<label
									class="flex min-h-14 items-start gap-3 rounded-[14px] border p-3 has-[:disabled]:opacity-50 {seat.ip ===
									seatIp
										? 'border-m-frost bg-m-frost/10'
										: 'border-m-edge bg-m-surface'}"
								>
									<input
										type="radio"
										name={`${uid}-seat`}
										value={seat.ip}
										checked={seat.ip === seatIp}
										disabled={!status.free}
										onchange={() => (seatIp = seat.ip)}
										class="mt-1 size-5 shrink-0 accent-m-frost"
									/>
									<span class="grid min-w-0 gap-1"
										><span class="font-mono text-[15px] font-semibold [overflow-wrap:anywhere]"
											>{seat.hostname} · {seat.ip}</span
										><span class="text-[14px] text-m-dim">{status.text}</span></span
									>
								</label>
							{/each}
						</div>
					{:else if mode === 'auto'}
						<p class="mt-3 text-[14px] text-m-dim">
							Docker assigns an address from {selected.subnet ?? 'the network pool'}. The alias and
							hostname stay as they are.
						</p>
					{:else}
						<div class="mt-3 grid gap-3">
							<label class="grid gap-1 text-[14px]"
								>IP address
								<input
									bind:value={customIp}
									aria-label="IP address"
									placeholder="any free address"
									inputmode="decimal"
									spellcheck="false"
									autocomplete="off"
									aria-invalid={Boolean(plan.ipError)}
									class="min-h-12 w-full min-w-0 rounded-xl border border-m-edge bg-m-surface px-3 font-mono text-[16px]"
								/>
								<span class={plan.ipError ? 'text-m-stop' : 'text-m-dim'}
									>{plan.ipError ?? selected.subnet ?? 'No IPv4 subnet'}</span
								>
							</label>
							<label class="grid gap-1 text-[14px]"
								>Alias and hostname
								<input
									bind:value={customAlias}
									aria-label="Alias and hostname"
									placeholder="keep the current name"
									autocapitalize="none"
									spellcheck="false"
									autocomplete="off"
									aria-invalid={Boolean(plan.aliasError)}
									class="min-h-12 w-full min-w-0 rounded-xl border border-m-edge bg-m-surface px-3 font-mono text-[16px]"
								/>
								{#if plan.aliasError}<span class="text-m-stop">{plan.aliasError}</span>{/if}
							</label>
						</div>
					{/if}
				</fieldset>

				<fieldset disabled={busy} class="grid gap-1 rounded-[14px] bg-m-surface px-3">
					<legend class="mb-2 text-[14px] font-semibold text-m-dim">Wiring</legend>
					<label class="flex min-h-14 items-start gap-3 py-3"
						><input
							type="checkbox"
							bind:checked={onlyNetwork}
							class="mt-1 size-5 shrink-0 accent-m-frost"
						/><span class="min-w-0"
							><span class="block text-[15px] font-semibold">Make it the only network</span><span
								class="block text-[14px] [overflow-wrap:anywhere] text-m-dim"
								>{leaving.length
									? `Disconnects ${leaving.join(', ')} after the connect.`
									: 'The container has no other network.'} Off by default: other connections stay.</span
							></span
						></label
					>
					<label
						class="flex min-h-14 items-start gap-3 border-t border-m-edge/60 py-3 has-[:disabled]:opacity-50"
						><input
							type="checkbox"
							bind:checked={setHostname}
							disabled={!aliasForHostname}
							class="mt-1 size-5 shrink-0 accent-m-frost"
						/><span class="min-w-0"
							><span class="block text-[15px] font-semibold [overflow-wrap:anywhere]"
								>Set the hostname{aliasForHostname ? ` to ${aliasForHostname}` : ''}</span
							><span class="block text-[14px] text-m-dim"
								>Runs as root and needs CAP_SYS_ADMIN. The alias works without it.</span
							></span
						></label
					>
					<label
						class="flex min-h-14 items-start gap-3 border-t border-m-edge/60 py-3 has-[:disabled]:opacity-50"
						><input
							type="checkbox"
							bind:checked={remember}
							disabled={connectionIdentity(container) === null}
							class="mt-1 size-5 shrink-0 accent-m-frost"
						/><span class="min-w-0"
							><span class="block text-[15px] font-semibold"
								>Offer to reconnect after a rebuild</span
							><span class="block text-[14px] text-m-dim"
								>A rebuild makes a new container without this network. Saved in this browser.
								Nothing reconnects by itself.</span
							></span
						></label
					>
				</fieldset>
			{/if}

			<details class="rounded-[14px] bg-m-surface p-3">
				<summary class="flex min-h-11 cursor-pointer items-center text-[14px] font-semibold"
					>Docker calls on the host</summary
				>
				{#if plan.request}<ol
						aria-label="Docker calls"
						class="grid gap-2 font-mono text-[14px] [overflow-wrap:anywhere]"
					>
						{#each commands as command, index (index)}<li>{command}</li>{/each}
					</ol>{:else}<p class="text-[14px] text-m-warn">{plan.error}</p>{/if}
			</details>
			{#if failure}<p role="alert" class="text-[15px] text-m-stop">{failure}</p>{/if}
			{#if hostnameWarning}<p role="status" class="text-[15px] text-m-warn">
					Connected. {hostnameWarning}
				</p>{/if}
		</div>
		<div class="sticky bottom-0 mt-3 border-t border-m-edge bg-m-screen px-4 pt-3 pb-1">
			{#if !plan.request}<p class="mb-2 text-[14px] text-m-warn">{plan.error}</p>{/if}
			{#if hostnameWarning}<MButton onclick={close}>Close</MButton>{:else}<MButton
					onclick={() => void submit()}
					disabled={!plan.request || busy}
					testid="network-submit"
					>{#if busy}<Loader2 size={18} class="animate-spin" />Connecting…{:else}<Network
							size={18}
						/>{plan.request?.alias ? `Connect as ${plan.request.alias}` : 'Connect'}{/if}</MButton
				>{/if}
		</div>
	{/if}
</MSheet>
