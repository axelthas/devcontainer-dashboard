<script lang="ts">
	/** The large action of a screen: 50 px high, full width, one per decision. */
	import type { Snippet } from 'svelte';

	interface Props {
		onclick: () => void;
		/** `primary` frost, `plain` raised, `danger` red text, `warn`, `brain` */
		tone?: 'primary' | 'plain' | 'danger' | 'danger-fill' | 'warn' | 'brain';
		disabled?: boolean;
		testid?: string;
		children: Snippet;
	}
	let { onclick, tone = 'primary', disabled = false, testid, children }: Props = $props();
	const TONES = {
		primary: 'bg-m-frost text-m-on-frost',
		plain: 'bg-m-raised text-m-ink',
		danger: 'bg-m-raised text-m-stop',
		'danger-fill': 'bg-m-stop text-white',
		warn: 'bg-m-warn text-[#2e3440]',
		brain: 'bg-m-brain text-[#2e3440]'
	} as const;
</script>

<button
	type="button"
	{onclick}
	{disabled}
	data-testid={testid}
	class="flex min-h-[50px] w-full items-center justify-center gap-2 rounded-[14px] px-3 text-[17px] font-semibold active:opacity-80 disabled:opacity-45 {TONES[
		tone
	]}"
>
	{@render children()}
</button>
