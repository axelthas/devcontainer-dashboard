<script lang="ts">
	/**
	 * Live strip above the tab bar while Brain runs a command: the container and the goal.
	 * It is the phone's stand-in for the desktop split view. Tapping it opens the Brain tab
	 * on that container's group. While a grant ends soon, the strip shows the countdown and
	 * opens the Extend access sheet instead.
	 */
	import { BrainCircuit, ChevronRight, Clock } from 'lucide-svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { useBrainAccess } from '$lib/brainAccess.svelte';
	import { buildActivity, headline, isRunningStep } from '$lib/brainActivity';
	import { formatCountdown, isEndingSoon } from '$lib/brainAlerts';

	const brain = useBrainAccess();
	/** The grant that ends first, while it is inside the warning window */
	const ending = $derived(
		(brain?.status?.grants ?? [])
			.filter((grant) => isEndingSoon(grant, brain?.now ?? Date.now()))
			.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))[0] ?? null
	);

	// Tick every second while the countdown shows; status polls run every five seconds.
	$effect(() => {
		if (!ending || !brain) return;
		const timer = setInterval(() => brain.tick(), 1000);
		return () => clearInterval(timer);
	});

	/** Open the Extend access sheet of the ending grant. */
	function extend() {
		if (!ending || !brain) return;
		brain.focus(ending.id);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() output plus a query
		void goto(`${resolve('/mobile/brain')}?extend=${encodeURIComponent(ending.id)}`);
	}
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

{#if ending}
	<button
		type="button"
		onclick={extend}
		class="fixed inset-x-3 z-30 flex items-center gap-3 rounded-2xl border border-m-warn/70 bg-m-surface/95 px-3 py-2.5 text-left shadow-xl backdrop-blur-xl"
		style:bottom="calc(60px + env(safe-area-inset-bottom))"
		data-testid="brain-strip-ending"
	>
		<span
			class="flex size-8 shrink-0 items-center justify-center rounded-full bg-m-warn/20 text-m-warn"
		>
			<Clock size={16} aria-hidden="true" />
		</span>
		<span class="min-w-0 flex-1">
			<span class="block truncate text-[13px] font-semibold text-m-warn tabular-nums"
				>Ends in {formatCountdown(ending.expiresAt, brain?.now ?? Date.now())} · {ending.containerName}</span
			>
			<span class="line-clamp-2 text-[15px] leading-snug text-m-ink"
				>{current && current.grantId === ending.id
					? current.text
					: (ending.intent ?? 'Brain access ends soon')}</span
			>
		</span>
		<span class="shrink-0 rounded-full bg-m-frost px-3 py-1.5 text-[14px] font-bold text-m-on-frost"
			>Extend</span
		>
	</button>
{:else if current}
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
