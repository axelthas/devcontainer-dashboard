<script lang="ts">
	import { ChevronDown, Copy, ExternalLink, Lock, Server } from 'lucide-svelte';
	import { PORT_MAP, getPortLabel } from '$lib/portConfig';
	import { openContainerService } from '$lib/serviceLaunch';
	import { copyAddress, foldBindings, webProtocol, type FoldedPort } from '$lib/publishedPorts';
	import type { ContainerData, ServiceAccess, ServicePortPolicy } from '$lib/types';
	import RowMenu from './RowMenu.svelte';

	interface Props {
		container: ContainerData;
		serviceProxyEnabled?: boolean;
		servicePorts?: ServicePortPolicy;
		serviceAccess?: ServiceAccess;
		/** Report a copied address, or why the copy failed. */
		onCopied: (message: string) => void;
	}
	let {
		container,
		serviceProxyEnabled,
		servicePorts = {},
		serviceAccess = 'direct',
		onCopied
	}: Props = $props();

	/** Docker's published bindings, or the plain port map when an older response has none. */
	const ports = $derived<FoldedPort[]>(
		container.portBindings?.length
			? foldBindings(container.portBindings)
			: Object.entries(container.ports).map(([containerPort, hostPort]) => ({
					containerPort,
					hostPort,
					protocol: 'tcp',
					addresses: [''],
					exposure: 'default' as const
				}))
	);
	/** Web ports open in the dashboard; one entry per container port. */
	const web = $derived(
		ports.filter(
			(port, index) =>
				webProtocol(servicePorts, port.containerPort, port.protocol) &&
				ports.findIndex((other) => other.containerPort === port.containerPort) === index
		)
	);
	/** Everything else is a socket address to copy. */
	const tcp = $derived(
		ports.filter((port) => !webProtocol(servicePorts, port.containerPort, port.protocol))
	);
	const running = $derived(container.state === 'running');
	const height = $derived(
		16 + (web.length ? 28 + web.length * 34 : 0) + (tcp.length ? 28 + tcp.length * 34 : 0) + 9
	);
	const accent = (port: string) =>
		PORT_MAP[port]?.accentClass ?? 'text-[#4c566a] dark:text-[#d8dee9]';

	/** Close first, then open the service window synchronously from the click. */
	function open(close: () => void, port: FoldedPort) {
		close();
		openContainerService({
			containerPort: port.containerPort,
			hostPort: container.ports[port.containerPort] ?? port.hostPort,
			label: getPortLabel(port.containerPort),
			containerName: container.name,
			projectName: container.projectName,
			workspacePath: container.localWorkspacePath,
			allPorts: container.ports,
			containerId: container.id,
			serviceProxyEnabled
		});
	}

	/** Copy the address a client connects to. The clipboard needs a secure context. */
	async function copy(close: () => void, port: FoldedPort) {
		close();
		const address = copyAddress(port, window.location.hostname);
		try {
			await navigator.clipboard.writeText(address);
			onCopied(`Copied ${address}`);
		} catch {
			onCopied(`Copy failed. Address: ${address}`);
		}
	}
</script>

<RowMenu
	label={`Services: ${container.projectName}`}
	menuLabel={`Services of ${container.projectName}`}
	title="Open or copy a service"
	width={264}
	{height}
	align="end"
	disabled={!running}
	triggerClass="flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-semibold whitespace-nowrap text-[#4c566a] hover:bg-[#e5e9f0] disabled:cursor-not-allowed disabled:opacity-50 aria-expanded:bg-[#e5e9f0] dark:text-[#d8dee9] dark:hover:bg-[#434c5e] dark:aria-expanded:bg-[#434c5e]"
>
	{#snippet trigger()}
		<!-- The icon stack shows what the container serves without opening the menu. -->
		<span class="flex items-center -space-x-1.5" aria-hidden="true">
			{#each Object.keys(container.ports) as port (port)}
				{@const Icon = PORT_MAP[port]?.icon ?? Server}
				<span
					class="flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-[#eceff4] dark:border-[#3b4252] dark:bg-[#2e3440]"
				>
					<Icon size={11} class={accent(port)} />
				</span>
			{/each}
		</span>
		Services <ChevronDown size={13} />
	{/snippet}
	{#snippet children(close: () => void)}
		{#if web.length > 0}
			<span class="menu-caption">Open in the dashboard</span>
			{#each web as port (port.containerPort)}
				{@const Icon = PORT_MAP[port.containerPort]?.icon ?? Server}
				<button role="menuitem" tabindex="-1" type="button" onclick={() => open(close, port)}>
					<Icon size={15} class={accent(port.containerPort)} />
					<span class="menu-text">{getPortLabel(port.containerPort)}</span>
					{#if serviceAccess === 'https'}
						<Lock size={12} class="text-[#a3be8c]" aria-label="HTTPS" />
					{/if}
					<ExternalLink size={12} aria-hidden="true" />
				</button>
			{/each}
		{/if}
		{#if web.length > 0 && tcp.length > 0}
			<div class="menu-divider" role="separator"></div>
		{/if}
		{#if tcp.length > 0}
			<span class="menu-caption">Not a web service: copy address</span>
			{#each tcp as port (`${port.containerPort}/${port.protocol}/${port.hostPort}`)}
				{@const Icon = PORT_MAP[port.containerPort]?.icon ?? Server}
				<button
					role="menuitem"
					tabindex="-1"
					type="button"
					title={port.protocol === 'tcp'
						? `To open it in the dashboard, add --gateway-ports ${port.containerPort}:http`
						: undefined}
					onclick={() => void copy(close, port)}
				>
					<Icon size={15} class={accent(port.containerPort)} />
					<span class="menu-text">{getPortLabel(port.containerPort)}</span>
					<span class="menu-hint font-mono" aria-hidden="true">:{port.hostPort}</span>
					<Copy size={12} aria-hidden="true" />
				</button>
			{/each}
		{/if}
	{/snippet}
</RowMenu>
