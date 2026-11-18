<script lang="ts">
	/**
	 * Drawer that connects a running devcontainer to an existing Docker network.
	 * Three choices, top to bottom: the network, who to be on it, and how to wire it.
	 * The exact Docker calls print below the form before anything runs.
	 */
	import { untrack } from 'svelte';
	import { Loader2, Network, TriangleAlert, X } from 'lucide-svelte';
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
	const headingId = `network-drawer-${uid}`;
	let heading = $state<HTMLHeadingElement>();
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

	/** Start a fresh form for a new target and move focus into the drawer. */
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
		queueMicrotask(() => heading?.focus());
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
		['seat', 'Stand in for a node'],
		['auto', 'Any free address'],
		['custom', 'Custom']
	];
	const radioCard =
		'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50';
	const selectedCard = 'border-[#5e9c9b] bg-[#8fbcbb]/15 dark:border-[#8fbcbb]';
	const idleCard =
		'border-[#d8dee9] hover:border-[#8fbcbb] dark:border-[#4c566a] dark:hover:border-[#8fbcbb]/70';
	const muted = 'text-[#4c566a] dark:text-[#d8dee9]/60';
	const legend = 'mb-2 text-xs font-semibold tracking-wide uppercase ' + muted;
</script>

<svelte:window
	onkeydown={(event) => {
		if (container && event.key === 'Escape') close();
	}}
/>

{#if container}
	<!-- Modal drawers must cover the terminal manager, including its collapsed bar. -->
	<div class="fixed inset-0 z-50 flex justify-end">
		<button
			type="button"
			tabindex="-1"
			aria-label="Close network drawer"
			class="absolute inset-0 cursor-default bg-[#2e3440]/50"
			onclick={close}
		></button>
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby={headingId}
			class="relative flex h-full min-h-0 w-full max-w-xl flex-col overflow-hidden border-l border-[#d8dee9] bg-white text-[#2e3440] shadow-xl dark:border-[#4c566a] dark:bg-[#3b4252] dark:text-[#eceff4]"
		>
			<header
				class="flex shrink-0 items-start justify-between gap-3 border-b border-[#d8dee9] px-5 py-4 dark:border-[#4c566a]"
			>
				<div class="min-w-0">
					<h2
						id={headingId}
						bind:this={heading}
						tabindex="-1"
						class="truncate text-base font-bold outline-none"
					>
						Connect {containerName}
					</h2>
					<p class="truncate text-xs {muted}">{container.projectName}</p>
				</div>
				<button
					type="button"
					aria-label="Close"
					disabled={busy}
					onclick={close}
					class="rounded p-1 {muted} hover:bg-[#e5e9f0] disabled:opacity-40 dark:hover:bg-[#434c5e]"
				>
					<X size={16} />
				</button>
			</header>

			<div class="grid min-h-0 flex-1 content-start gap-6 overflow-y-auto px-5 py-4 text-sm">
				<fieldset disabled={busy}>
					<legend class={legend}>Network · existing networks only</legend>
					{#if networksError}
						<p role="alert" class="mb-2 text-xs text-[#bf616a]">{networksError}</p>
					{/if}
					{#if sortedNetworks.length === 0}
						<p class="text-xs {muted}">
							No user-defined networks found. Start the sandbox first. The dashboard does not create
							networks.
						</p>
					{/if}
					<div class="grid gap-2">
						{#each sortedNetworks as entry (entry.name)}
							<label class="{radioCard} {entry.name === networkName ? selectedCard : idleCard}">
								<input
									type="radio"
									name={`${uid}-network`}
									value={entry.name}
									checked={entry.name === networkName}
									onchange={() => selectNetwork(entry.name)}
									class="mt-1 accent-[#5e9c9b]"
								/>
								<span class="grid min-w-0 gap-0.5">
									<span class="flex flex-wrap items-center gap-2">
										<span class="font-mono font-semibold break-all">{entry.name}</span>
										{#if container.networkPresets?.some((preset) => preset.network === entry.name)}
											<span
												class="rounded border border-[#8fbcbb]/50 px-1.5 text-xs text-[#5e9c9b] dark:text-[#8fbcbb]"
												>devcontainer.json</span
											>
										{/if}
										{#if attached.some((current) => current.name === entry.name)}
											<span
												class="rounded border border-[#81a1c1]/50 px-1.5 text-xs text-[#5e81ac] dark:text-[#81a1c1]"
												>connected</span
											>
										{/if}
									</span>
									<span class="text-xs {muted}">{summary(entry)}</span>
								</span>
							</label>
						{/each}
					</div>
				</fieldset>

				{#if selected}
					<fieldset disabled={busy}>
						<legend class={legend}>Join as</legend>
						<div class="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Join as">
							{#each MODES as [value, label] (value)}
								<label
									class="flex cursor-pointer items-center justify-center gap-2 rounded-lg border px-2 py-1.5 text-center text-xs font-medium has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#81a1c1] {mode ===
									value
										? selectedCard
										: idleCard}"
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
							<div
								class="mt-3 grid gap-1.5"
								role="radiogroup"
								aria-label={`Seats on ${selected.name}`}
							>
								{#each seats as seat (seat.ip)}
									{@const status = seatStatus(selected, seat, container.id)}
									<label
										class="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 {seat.ip ===
										seatIp
											? selectedCard
											: idleCard}"
									>
										<input
											type="radio"
											name={`${uid}-seat`}
											value={seat.ip}
											checked={seat.ip === seatIp}
											disabled={!status.free}
											onchange={() => (seatIp = seat.ip)}
											class="accent-[#5e9c9b]"
										/>
										<span class="w-36 truncate font-mono font-semibold">{seat.hostname}</span>
										<span class="w-28 font-mono text-xs {muted}">{seat.ip}</span>
										<span class="min-w-0 flex-1 truncate text-xs {muted}">{status.text}</span>
									</label>
								{/each}
							</div>
						{:else if mode === 'auto'}
							<p class="mt-3 text-xs {muted}">
								Docker assigns an address from
								<span class="font-mono">{selected.subnet ?? 'the network pool'}</span>. The alias
								and the hostname stay as they are.
							</p>
						{:else}
							<div class="mt-3 grid gap-3 sm:grid-cols-2">
								<label class="grid gap-1 text-xs">
									<span class="font-medium">IP address</span>
									<input
										bind:value={customIp}
										placeholder="any free address"
										spellcheck="false"
										autocomplete="off"
										aria-invalid={Boolean(plan.ipError)}
										class="rounded-md border border-[#d8dee9] bg-white px-2 py-1.5 font-mono text-[#2e3440] dark:border-[#4c566a] dark:bg-[#2e3440] dark:text-[#eceff4]"
									/>
									<span class={plan.ipError ? 'text-[#bf616a]' : muted}
										>{plan.ipError ?? selected.subnet ?? 'No IPv4 subnet'}</span
									>
								</label>
								<label class="grid gap-1 text-xs">
									<span class="font-medium">Alias and hostname</span>
									<input
										bind:value={customAlias}
										placeholder="keep the current name"
										spellcheck="false"
										autocomplete="off"
										aria-invalid={Boolean(plan.aliasError)}
										class="rounded-md border border-[#d8dee9] bg-white px-2 py-1.5 font-mono text-[#2e3440] dark:border-[#4c566a] dark:bg-[#2e3440] dark:text-[#eceff4]"
									/>
									{#if plan.aliasError}<span class="text-[#bf616a]">{plan.aliasError}</span>{/if}
								</label>
							</div>
						{/if}
					</fieldset>

					<fieldset disabled={busy} class="grid gap-3">
						<legend class={legend}>Wiring</legend>
						<label class="flex items-start gap-3">
							<input type="checkbox" bind:checked={onlyNetwork} class="mt-1 accent-[#5e9c9b]" />
							<span class="grid gap-0.5">
								<span class="font-medium">Make it the only network</span>
								<span class="text-xs {muted}"
									>{leaving.length
										? `Disconnects ${leaving.join(', ')} after the connect.`
										: 'The container has no other network.'} Off by default: other connections stay.</span
								>
							</span>
						</label>
						<label class="flex items-start gap-3 has-[:disabled]:opacity-50">
							<input
								type="checkbox"
								bind:checked={setHostname}
								disabled={!aliasForHostname}
								class="mt-1 accent-[#5e9c9b]"
							/>
							<span class="grid gap-0.5">
								<span class="font-medium"
									>Set the container hostname{aliasForHostname
										? ` to ${aliasForHostname}`
										: ''}</span
								>
								<span class="text-xs {muted}"
									>Runs as root and needs CAP_SYS_ADMIN. The alias works without it.</span
								>
							</span>
						</label>
						<label class="flex items-start gap-3 has-[:disabled]:opacity-50">
							<input
								type="checkbox"
								bind:checked={remember}
								disabled={connectionIdentity(container) === null}
								class="mt-1 accent-[#5e9c9b]"
							/>
							<span class="grid gap-0.5">
								<span class="font-medium">Offer to reconnect after a rebuild</span>
								<span class="text-xs {muted}"
									>A rebuild makes a new container without this network. Saved in this browser.</span
								>
							</span>
						</label>
					</fieldset>
				{/if}

				<section class="grid gap-2">
					<h3 class={legend}>Runs on the dashboard host</h3>
					{#if plan.request}
						<ol
							aria-label="Docker calls"
							class="grid gap-1 rounded-lg border border-[#d8dee9] bg-[#f0f4f8] p-3 font-mono text-xs dark:border-[#4c566a] dark:bg-[#2e3440]"
						>
							{#each commands as command, index (index)}
								<li class="break-all">{command}</li>
							{/each}
						</ol>
					{:else}
						<p class="flex items-center gap-2 text-xs text-[#d08770]">
							<TriangleAlert size={14} class="shrink-0" />{plan.ipError || plan.aliasError
								? 'Correct the highlighted field.'
								: plan.error}
						</p>
					{/if}
				</section>

				{#if failure}
					<p role="alert" class="text-xs text-[#bf616a]">{failure}</p>
				{/if}
				{#if hostnameWarning}
					<p role="status" class="text-xs text-[#d08770]">
						Connected. {hostnameWarning}
					</p>
				{/if}
			</div>

			<footer
				class="flex shrink-0 justify-end gap-2 border-t border-[#d8dee9] px-5 py-3 dark:border-[#4c566a]"
			>
				<button
					type="button"
					disabled={busy}
					onclick={close}
					class="rounded-lg px-3 py-1.5 text-xs font-medium {muted} hover:bg-[#e5e9f0] disabled:opacity-40 dark:hover:bg-[#434c5e]"
				>
					{hostnameWarning ? 'Close' : 'Cancel'}
				</button>
				{#if !hostnameWarning}
					<button
						type="button"
						disabled={!plan.request || busy}
						onclick={() => void submit()}
						class="flex items-center gap-1.5 rounded-lg bg-[#5e81ac] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#81a1c1] disabled:cursor-not-allowed disabled:opacity-50"
					>
						{#if busy}
							<Loader2 size={12} class="animate-spin" />Connecting…
						{:else}
							<Network size={12} />{plan.request?.alias
								? `Connect as ${plan.request.alias}`
								: 'Connect'}
						{/if}
					</button>
				{/if}
			</footer>
		</div>
	</div>
{/if}
