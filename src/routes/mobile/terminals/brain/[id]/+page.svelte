<script lang="ts">
	/** One Brain command, full screen. The Brain viewer keeps its own take-over controls. */
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useBrainAccess } from '$lib/brainAccess.svelte';
	import BrainTerminalTab from '$lib/components/BrainTerminalTab.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';

	const brain = useBrainAccess();
	const execution = $derived(brain?.status?.executions.find((e) => e.id === page.params.id));
</script>

<div
	class="fixed inset-x-0 flex flex-col bg-m-screen"
	style:top="var(--visual-viewport-top, 0px)"
	style:height="var(--visual-viewport-height, 100dvh)"
>
	<MNavBar back={{ href: resolve('/mobile/terminals'), label: 'Terminals' }} />
	{#if execution && brain}
		<div class="px-4 pb-2">
			<div class="text-[17px] font-semibold [overflow-wrap:anywhere]">
				{execution.shell ? `Shell ${execution.shell.name}` : execution.command}
			</div>
			<div class="text-[14px] text-m-dim">{execution.containerName} · as {execution.user}</div>
		</div>
		<div class="min-h-0 flex-1 bg-m-term" style:padding-bottom="env(safe-area-inset-bottom)">
			<BrainTerminalTab {execution} access={brain} visible={true} />
		</div>
	{:else}
		<p class="px-8 py-12 text-center text-[16px] text-m-dim">
			{brain?.status ? 'This Brain command is no longer listed.' : 'Reading Brain status…'}
		</p>
	{/if}
</div>
