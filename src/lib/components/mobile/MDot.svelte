<script lang="ts">
	/** Container state as a dot: green running, yellow pulsing while busy, grey otherwise. */
	interface Props {
		state: string;
		busy?: boolean;
	}
	let { state, busy = false }: Props = $props();
	const color = $derived(
		busy ? 'bg-m-warn animate-pulse' : state === 'running' ? 'bg-m-run' : 'bg-m-edge'
	);
</script>

<span
	role="img"
	aria-label={busy ? 'busy' : state}
	class="inline-block size-2.5 shrink-0 rounded-full {color}"
></span>
