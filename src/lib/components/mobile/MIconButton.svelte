<script lang="ts">
	import { Ellipsis, type Box } from 'lucide-svelte';

	interface Props {
		label: string;
		onclick: () => void;
		icon?: typeof Box;
		testid?: string;
	}
	let { label, onclick, icon: Icon = Ellipsis, testid }: Props = $props();
</script>

<button
	type="button"
	aria-label={label}
	{onclick}
	data-testid={testid}
	class="flex size-11 items-center justify-center rounded-full text-m-frost active:bg-m-raised"
>
	<Icon size={22} aria-hidden="true" />
</button>
