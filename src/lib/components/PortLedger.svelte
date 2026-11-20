<script lang="ts">
	import { Lock, Server, ShieldAlert } from 'lucide-svelte';
	import { PORT_MAP, getPortLabel } from '$lib/portConfig';
	import { displayAddress, foldBindings, webProtocol } from '$lib/publishedPorts';
	import type { PublishedPortBinding, ServiceAccess, ServicePortPolicy } from '$lib/types';

	interface Props {
		bindings?: PublishedPortBinding[];
		servicePorts?: ServicePortPolicy;
		serviceAccess?: ServiceAccess;
		running?: boolean;
	}
	let {
		bindings = [],
		servicePorts = {},
		serviceAccess = 'direct',
		running = true
	}: Props = $props();

	/** IPv4 and IPv6 bindings of one port share a line. */
	const ports = $derived(foldBindings(bindings));
	const anyWildcard = $derived(ports.some((port) => port.exposure === 'all'));
	const EXPOSURE = {
		all: 'All interfaces',
		loopback: 'Loopback only',
		specific: 'Specific interface',
		default: 'Default interface'
	};
	const WEB_ACCESS: Record<ServiceAccess, string> = {
		https: 'HTTPS in dashboard',
		gateway: 'Dashboard gateway',
		direct: 'Opens over HTTP'
	};
	const accent = (port: string) =>
		PORT_MAP[port]?.accentClass ?? 'text-[#4c566a] dark:text-[#d8dee9]';
</script>

{#if ports.length > 0}
	<ul aria-label="Published ports" class="grid gap-1">
		{#each ports as port (`${port.containerPort}/${port.protocol}/${port.hostPort}`)}
			{@const Icon = PORT_MAP[port.containerPort]?.icon ?? Server}
			{@const web = webProtocol(servicePorts, port.containerPort, port.protocol)}
			<li
				class="port-ledger-row grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-b border-[#4c566a]/30 py-2 last:border-0 md:grid-cols-[9rem_9rem_minmax(0,1fr)_auto]"
			>
				<span class="flex min-w-0 items-center gap-1.5 text-[#2e3440] dark:text-[#d8dee9]">
					<Icon size={13} class="shrink-0 {accent(port.containerPort)}" />
					<span class="truncate">{getPortLabel(port.containerPort)}</span>
				</span>
				<span class="font-mono text-[#2e3440] dark:text-[#d8dee9]"
					>{port.containerPort}{port.protocol === 'tcp' ? '' : `/${port.protocol}`} → {port.hostPort}</span
				>
				<span class="col-span-2 flex min-w-0 flex-wrap items-center gap-1 text-xs md:col-span-1">
					{#each port.addresses as address (address)}
						<span
							class="rounded border px-1 font-mono {port.exposure === 'all'
								? 'border-[#b48ead]/40 text-[#b48ead]'
								: 'border-[#d8dee9] text-[#4c566a] dark:border-[#4c566a] dark:text-[#d8dee9]/70'}"
							>{displayAddress(address)}</span
						>
					{/each}
					<span class="text-[#4c566a] dark:text-[#d8dee9]/60">{EXPOSURE[port.exposure]}</span>
				</span>
				{#if web}
					<span
						class="flex items-center gap-1 {running
							? 'text-[#5b8a4a] dark:text-[#a3be8c]'
							: 'text-[#4c566a] dark:text-[#d8dee9]/60'}"
					>
						{#if serviceAccess === 'https'}<Lock size={11} />{/if}
						{WEB_ACCESS[serviceAccess]}
					</span>
				{:else}
					<span
						class="text-[#4c566a] dark:text-[#d8dee9]/60"
						title={port.protocol === 'tcp'
							? `Not a web service. To open it in the dashboard, add --gateway-ports ${port.containerPort}:http`
							: undefined}
					>
						{port.protocol === 'tcp' ? 'TCP · copy address' : port.protocol.toUpperCase()}
					</span>
				{/if}
			</li>
		{/each}
	</ul>
	{#if anyWildcard}
		<p class="mt-1.5 flex items-start gap-1.5 text-[#4c566a] dark:text-[#d8dee9]/60">
			<ShieldAlert size={13} class="mt-0.5 shrink-0 text-[#b48ead]" />
			HTTPS in the dashboard does not close these ports. Direct access depends on your host firewall.
		</p>
	{/if}
{:else}
	<span class="text-[#4c566a] dark:text-[#d8dee9]/60">No published ports</span>
{/if}
