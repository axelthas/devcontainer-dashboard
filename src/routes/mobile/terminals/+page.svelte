<script lang="ts">
	/** Every terminal session on the host, and Brain's commands. Leaving one never stops it. */
	import { BrainCircuit, Plus, SquareTerminal } from 'lucide-svelte';
	import { resolve } from '$app/paths';
	import { useBrainAccess } from '$lib/brainAccess.svelte';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';
	import MGroup from '$lib/components/mobile/MGroup.svelte';
	import MIconButton from '$lib/components/mobile/MIconButton.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';
	import MNewShellSheet from '$lib/components/mobile/MNewShellSheet.svelte';
	import MRow from '$lib/components/mobile/MRow.svelte';

	const dashboard = useMobileDashboard();
	const brain = useBrainAccess();
	/** Server sessions, plus starts from this phone that the server has not listed yet. */
	const sessions = $derived([
		...dashboard.sessions,
		...[...dashboard.starts.values()]
			.filter((start) => !dashboard.sessions.some((session) => session.id === start.id))
			.map((start) => ({ id: start.id, name: start.name ?? 'Terminal', cwd: start.cwd }))
	]);
	const executions = $derived(
		[...(brain?.status?.executions ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
	);
</script>

<MNavBar title="Terminals">
	{#snippet right()}
		<MIconButton icon={Plus} label="New shell" onclick={() => (dashboard.newShellOpen = true)} />
	{/snippet}
</MNavBar>

{#if sessions.length === 0}
	<p class="px-8 py-8 text-center text-[15px] text-m-dim" data-testid="terminals-empty">
		No terminal sessions. Start a shell with +.
	</p>
{:else}
	<MGroup
		title="Sessions"
		footer="Sessions keep running when you leave, lock the phone or switch to the desktop."
	>
		{#each sessions as session (session.id)}
			<MRow
				title={session.name}
				subtitle={session.cwd || undefined}
				href={dashboard.terminalHref(session.id)}
				testid="terminal-row"
			>
				{#snippet icon()}<SquareTerminal size={18} />{/snippet}
			</MRow>
		{/each}
	</MGroup>
{/if}
{#if executions.length}
	<MGroup title="Brain" footer="You watch Brain's commands. Take over a shell to type.">
		{#each executions.slice(0, 20) as execution (execution.id)}
			<MRow
				title={execution.shell ? `Shell ${execution.shell.name}` : execution.command}
				subtitle={`${execution.containerName} · ${execution.status}`}
				tone="bg-m-brain/15 text-m-brain"
				href={resolve('/mobile/terminals/brain/[id]', { id: execution.id })}
			>
				{#snippet icon()}<BrainCircuit size={18} />{/snippet}
			</MRow>
		{/each}
	</MGroup>
{/if}
<MNewShellSheet />
