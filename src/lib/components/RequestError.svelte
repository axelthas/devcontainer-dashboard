<script lang="ts">
	import { resolve } from '$app/paths';
	import { SESSION_EXPIRED } from '$lib/requests';

	interface Props {
		message: string;
		onRetry?: () => void;
	}
	let { message, onRetry }: Props = $props();
</script>

{#if message}
	<div role="alert" class="my-2 text-sm text-[#bf616a]">
		<span>{message}</span>
		{#if message.includes(SESSION_EXPIRED)}
			<a class="ml-2 underline" href={resolve('/login')}>Sign in again</a>
		{:else if onRetry}
			<button type="button" class="ml-2 underline" onclick={onRetry}>Retry</button>
		{/if}
	</div>
{/if}
