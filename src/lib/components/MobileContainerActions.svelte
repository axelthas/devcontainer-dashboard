<script lang="ts">
	/** Phone-only action bar: stable columns, with rare actions in a bottom sheet. */
	import { TerminalSquare, Play } from 'lucide-svelte';
	import { generateId } from '$lib';
	import type { ContainerData, ServiceAccess, ServicePortPolicy } from '$lib/types';
	import type { ContainerActions } from '$lib/containerActions.svelte';
	import { containerShellCommand, containerShellBlocker } from '$lib/containerOpenTargets';
	import OpenWithMenu from './OpenWithMenu.svelte';
	import SandboxOpenWithMenu from './SandboxOpenWithMenu.svelte';
	import ContainerMoreMenu from './ContainerMoreMenu.svelte';
	import BrainAccessButton from './BrainAccessButton.svelte';
	import ServicesMenu from './ServicesMenu.svelte';
	import SandboxServicesMenu from './SandboxServicesMenu.svelte';

	interface Props {
		container: ContainerData;
		actions: ContainerActions;
		vscodeSshHost?: string;
		serviceProxyEnabled?: boolean;
		servicePorts?: ServicePortPolicy;
		serviceAccess?: ServiceAccess;
		sandbox?: boolean;
		onOpenTerminal?: (id: string, command: string, name: string, cwd: string) => void;
		onConnectNetwork?: () => void;
		onDisconnectNetwork?: (network: string) => void;
	}
	let {
		container,
		actions,
		vscodeSshHost,
		serviceProxyEnabled,
		servicePorts,
		serviceAccess,
		sandbox = false,
		onOpenTerminal,
		onConnectNetwork,
		onDisconnectNetwork
	}: Props = $props();
	let feedback = $state('');
	const running = $derived(container.state === 'running');
	const command = $derived(
		sandbox
			? `docker exec -it ${container.name.replace(/^\//, '')} bash || docker exec -it ${container.name.replace(/^\//, '')} sh`
			: containerShellCommand(container)
	);
	const blocker = $derived(sandbox ? null : containerShellBlocker(container));
	/** Launch only on explicit activation; the menu retains all existing target checks. */
	function terminal() {
		if (!command || !running || blocker || !onOpenTerminal) return;
		onOpenTerminal(generateId(), command, container.projectName, '.');
	}
</script>

<div
	class="mobile-container-actions grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_44px] items-center gap-2 md:hidden"
>
	<div class="min-w-0 rounded-xl border border-[#d8dee9] dark:border-[#4c566a]">
		{#if sandbox}
			<SandboxOpenWithMenu
				{container}
				{vscodeSshHost}
				disabled={actions.busy}
				onOpenTerminal={terminal}
			/>
		{:else}
			<OpenWithMenu
				path={container.localWorkspacePath ?? ''}
				{container}
				{vscodeSshHost}
				{serviceProxyEnabled}
				disabled={actions.busy}
				onOpenTerminal={(...args) => onOpenTerminal?.(...args)}
			/>
		{/if}
	</div>
	<button
		type="button"
		onclick={() => {
			if (running) terminal();
			else void actions.run('start');
		}}
		disabled={actions.busy || (running && (Boolean(blocker) || !onOpenTerminal))}
		title={blocker ?? undefined}
		class="flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-xl border border-[#d8dee9] px-2 text-sm text-[#4c566a] disabled:opacity-40 dark:border-[#4c566a] dark:text-[#d8dee9]"
	>
		{#if running}<TerminalSquare size={16} /> Terminal{:else}<Play size={16} /> Start{/if}
	</button>
	<ContainerMoreMenu
		{container}
		{actions}
		{onConnectNetwork}
		{onDisconnectNetwork}
		rebuild={!sandbox}
	>
		{#snippet extras(close)}
			{#if running && Object.keys(container.ports).length}
				{#if sandbox}
					<SandboxServicesMenu
						{container}
						{serviceProxyEnabled}
						{servicePorts}
						{serviceAccess}
						onCopied={(message) => {
							feedback = message;
						}}
					/>
				{:else}
					<ServicesMenu {container} {serviceProxyEnabled} />
				{/if}
			{/if}
			<BrainAccessButton {container} onOpen={close} menuItem />
		{/snippet}
	</ContainerMoreMenu>
</div>

{#if feedback}<p role="status" class="text-sm md:hidden">{feedback}</p>{/if}
