<script lang="ts" module>
	/** Icon tile classes of a Brain step outcome, for `MRow` tone. */
	const TONES = {
		running: 'bg-m-warn/15 text-m-warn',
		ok: 'bg-m-run/15 text-m-run',
		failed: 'bg-m-stop/15 text-m-stop',
		ended: 'bg-m-raised text-m-dim'
	} as const;
	export type StepOutcome = keyof typeof TONES;
	export function tone(outcome: StepOutcome): string {
		return TONES[outcome];
	}
</script>

<script lang="ts">
	/** Status icon of one Brain command: spinning while it runs, then its result. */
	import { Check, Loader2, Square, X } from 'lucide-svelte';

	interface Props {
		outcome: StepOutcome;
	}
	let { outcome }: Props = $props();
</script>

{#if outcome === 'running'}
	<Loader2 size={16} class="animate-spin" aria-label="Running" />
{:else if outcome === 'ok'}
	<Check size={16} aria-label="Succeeded" />
{:else if outcome === 'failed'}
	<X size={16} aria-label="Failed" />
{:else}
	<Square size={12} aria-label="Ended" />
{/if}
