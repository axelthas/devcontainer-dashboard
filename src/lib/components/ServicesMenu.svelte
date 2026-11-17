<script lang="ts">
	import { ChevronDown, ExternalLink, Server } from 'lucide-svelte';
	import type { ContainerData } from '$lib/types';
	import { PORT_MAP, getPortLabel } from '$lib/portConfig';
	import { openContainerService } from '$lib/serviceLaunch';
	import RowMenu from './RowMenu.svelte';

	interface Props {
		container: ContainerData;
		serviceProxyEnabled?: boolean;
	}
	let { container, serviceProxyEnabled }: Props = $props();

	const ports = $derived(Object.keys(container.ports));
	const running = $derived(container.state === 'running');
	/** Icon tint of a known service; unknown ports use the neutral text color. */
	const accent = (port: string) =>
		PORT_MAP[port]?.accentClass ?? 'text-[#4c566a] dark:text-[#d8dee9]';

	/** Close first, then open the service window synchronously from the click. */
	function open(close: () => void, containerPort: string) {
		close();
		openContainerService({
			containerPort,
			hostPort: container.ports[containerPort],
			label: getPortLabel(containerPort),
			containerName: container.name,
			projectName: container.projectName,
			workspacePath: container.localWorkspacePath,
			allPorts: container.ports,
			containerId: container.id,
			serviceProxyEnabled
		});
	}
</script>

<RowMenu
	label={`Services: ${container.projectName}`}
	menuLabel={`Services of ${container.projectName}`}
	title="Open a service"
	width={240}
	height={40 + ports.length * 34}
	align="end"
	disabled={!running}
	triggerClass="flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-semibold whitespace-nowrap text-[#4c566a] hover:bg-[#e5e9f0] disabled:cursor-not-allowed disabled:opacity-50 aria-expanded:bg-[#e5e9f0] dark:text-[#d8dee9] dark:hover:bg-[#434c5e] dark:aria-expanded:bg-[#434c5e]"
>
	{#snippet trigger()}
		<!-- The icon stack shows what the container serves without opening the menu. -->
		<span class="flex items-center -space-x-1.5" aria-hidden="true">
			{#each ports as port (port)}
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
		<span class="menu-caption"
			>{ports.length} published {ports.length === 1 ? 'port' : 'ports'}</span
		>
		{#each ports as port (port)}
			{@const Icon = PORT_MAP[port]?.icon ?? Server}
			<button role="menuitem" tabindex="-1" type="button" onclick={() => open(close, port)}>
				<Icon size={15} class={accent(port)} />
				<span class="menu-text">{getPortLabel(port)}</span>
				<span class="menu-hint font-mono" aria-hidden="true">:{port}</span>
				<ExternalLink size={12} aria-hidden="true" />
			</button>
		{/each}
	{/snippet}
</RowMenu>
