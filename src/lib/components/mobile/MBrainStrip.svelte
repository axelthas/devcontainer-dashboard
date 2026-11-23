<script lang="ts">
	/**
	 * Live strip above the tab bar while Brain runs a command: the container and the goal.
	 * It is the phone's stand-in for the desktop split view. Tapping it opens the Brain tab
	 * on that container's group.
	 */
	import { BrainCircuit, ChevronRight } from 'lucide-svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { useBrainAccess } from '$lib/brainAccess.svelte';
	import { buildActivity, headline, isRunningStep } from '$lib/brainActivity';

	const brain = useBrainAccess();
	/** The newest running command across the groups. */
	const current = $derived.by(() => {
		let found: { grantId: string; container: string; text: string; at: string } | null = null;
		for (const group of buildActivity(brain?.status ?? null).groups)
			for (const step of group.steps)
				if (isRunningStep(step) && (!found || step.startedAt > found.at))
					found = {
						grantId: group.grantId,
						container: group.containerName,
						text: step.goal ?? headline(step.command),
						at: step.startedAt
					};
		return found;
	});

	function open() {
		if (!current || !brain) return;
		brain.focus(current.grantId);
		void goto(resolve('/mobile/brain'));
	}
</script>

{#if current}
	<button
		type="button"
		onclick={open}
		class="fixed inset-x-3 z-30 flex items-center gap-3 rounded-2xl border border-m-brain/40 bg-m-surface/95 px-3 py-2.5 text-left shadow-xl backdrop-blur-xl"
		style:bottom="calc(60px + env(safe-area-inset-bottom))"
		data-testid="brain-strip"
	>
		<span
			class="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-m-brain/20 text-m-brain"
		>
			<BrainCircuit size={16} aria-hidden="true" />
			<span
				class="absolute -top-0.5 -right-0.5 size-2.5 animate-pulse rounded-full bg-m-warn ring-2 ring-m-surface"
			></span>
		</span>
		<span class="min-w-0 flex-1">
			<span class="block truncate text-[13px] text-m-dim">Brain · {current.container}</span>
			<span class="line-clamp-2 text-[15px] leading-snug text-m-ink">{current.text}</span>
		</span>
		<ChevronRight size={18} class="shrink-0 text-m-dim" aria-hidden="true" />
	</button>
{/if}
