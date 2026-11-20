<script lang="ts">
	/** A state message above the content, with at most one action. */
	import type { Box } from 'lucide-svelte';

	interface Props {
		icon: typeof Box;
		/** For example `bg-m-stop/15 text-m-stop` */
		tone: string;
		title: string;
		detail?: string;
		action?: string;
		onAction?: () => void;
		testid?: string;
	}
	let { icon: Icon, tone, title, detail, action, onAction, testid }: Props = $props();
</script>

<div
	class="mx-4 mb-4 flex items-start gap-3 rounded-[14px] p-3.5 {tone}"
	role="status"
	data-testid={testid}
>
	<Icon size={20} class="mt-0.5 shrink-0" aria-hidden="true" />
	<div class="min-w-0 flex-1">
		<div class="text-[16px] font-semibold [overflow-wrap:anywhere]">{title}</div>
		{#if detail}
			<div class="text-[14px] leading-snug [overflow-wrap:anywhere] opacity-90">{detail}</div>
		{/if}
	</div>
	{#if action && onAction}
		<button
			type="button"
			onclick={onAction}
			class="min-h-11 shrink-0 px-1 text-[15px] font-semibold">{action}</button
		>
	{/if}
</div>
