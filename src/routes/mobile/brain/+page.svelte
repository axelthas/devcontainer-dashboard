<script lang="ts">
	/**
	 * Brain tab: the phone form of the desktop split view. Brain's commands, grouped by
	 * container and led by their goals. A terminal opens only when the operator asks for one.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { useBrainAccess } from '$lib/brainAccess.svelte';
	import BrainActivity from '$lib/components/BrainActivity.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';

	const brain = useBrainAccess();
</script>

<MNavBar title="Brain" />

<div class="px-4 pb-6 text-sm" data-testid="brain-tab">
	{#if !brain?.status}
		<p class="py-8 text-center text-[15px] text-m-dim">Reading Brain status…</p>
	{:else if !brain.status.enabled}
		<p class="py-8 text-center text-[15px] text-m-dim">
			Brain shell access is disabled. Start the dashboard with --brain to enable it.
		</p>
	{:else}
		<BrainActivity
			access={brain}
			compact
			onOpenTerminal={(id) => void goto(resolve('/mobile/terminals/brain/[id]', { id }))}
		/>
	{/if}
</div>
