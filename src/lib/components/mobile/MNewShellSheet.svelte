<script lang="ts">
	/** Start a shell in a running devcontainer or on the host, then open it full screen. */
	import { Server } from 'lucide-svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { containerShellCommand } from '$lib/containerOpenTargets';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';
	import type { ContainerData } from '$lib/types';
	import MDot from './MDot.svelte';
	import MGroup from './MGroup.svelte';
	import MRow from './MRow.svelte';
	import MSheet from './MSheet.svelte';

	const dashboard = useMobileDashboard();
	const running = $derived(dashboard.devcontainers.filter((c) => c.state === 'running'));

	/** Register the start and show the terminal; the terminal screen starts the process. */
	function open(name: string, command: string, cwd: string) {
		dashboard.newShellOpen = false;
		const id = dashboard.openTerminal({ name, command, cwd, kind: 'shell' });
		void goto(resolve('/mobile/terminals/[id]', { id }));
	}

	function openIn(container: ContainerData) {
		const command = containerShellCommand(container);
		if (command) open(container.projectName, command, container.localWorkspacePath ?? '');
	}
</script>

<MSheet
	open={dashboard.newShellOpen}
	title="New shell"
	onClose={() => (dashboard.newShellOpen = false)}
	testid="new-shell-sheet"
>
	{#if running.length}
		<MGroup title="In a container">
			{#each running as container (container.id)}
				<MRow
					title={container.projectName}
					subtitle={container.remoteUserError ??
						(container.remoteUser ? `as ${container.remoteUser}` : container.name.replace(/^\//, ''))}
					onclick={() => openIn(container)}
					disabled={!containerShellCommand(container)}
					tone="bg-transparent"
					chevron
				>
					{#snippet icon()}<MDot state="running" />{/snippet}
				</MRow>
			{/each}
		</MGroup>
	{/if}
	<MGroup title="On the host">
		<MRow
			title={dashboard.hostname}
			subtitle={dashboard.workspaceRoot}
			onclick={() => open(dashboard.hostname, '', dashboard.workspaceRoot)}
			chevron
		>
			{#snippet icon()}<Server size={18} />{/snippet}
		</MRow>
	</MGroup>
</MSheet>
