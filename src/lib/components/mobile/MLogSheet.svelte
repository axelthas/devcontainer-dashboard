<script lang="ts">
	/** The kept output of a failed run as plain, wrapping text, with a download link. */
	import { Download } from 'lucide-svelte';
	import { errorMessage, requestText } from '$lib/requests';
	import MSheet from './MSheet.svelte';

	interface Props {
		open: boolean;
		logId: string;
		title: string;
		onClose: () => void;
	}
	let { open, logId, title, onClose }: Props = $props();
	let text = $state('');
	let loading = $state(false);
	let error = $state('');
	const href = $derived(`/api/run-logs/${encodeURIComponent(logId)}?download`);

	// Read the plain-text form each time the sheet opens; logs are small and can change.
	$effect(() => {
		if (!open) return;
		const controller = new AbortController();
		loading = true;
		error = '';
		requestText(href, { signal: controller.signal })
			.then((value) => (text = value))
			.catch((cause) => {
				if (!controller.signal.aborted) error = errorMessage(cause);
			})
			.finally(() => {
				if (!controller.signal.aborted) loading = false;
			});
		return () => controller.abort();
	});
</script>

<MSheet {open} {title} {onClose} testid="log-sheet">
	<div class="px-4">
		{#if loading}
			<p role="status" class="py-6 text-center text-[15px] text-m-dim">Reading the log…</p>
		{:else if error}
			<p role="alert" class="py-6 text-[15px] text-m-stop">{error}</p>
		{:else}
			<pre
				class="max-h-[60dvh] overflow-y-auto rounded-xl bg-m-term p-3 font-mono text-[13px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-[#d8dee9]">{text ||
					'The log is empty.'}</pre>
		{/if}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- API download, not a page -->
		<a
			{href}
			class="mt-3 flex min-h-[50px] items-center justify-center gap-2 rounded-[14px] bg-m-raised text-[17px] font-semibold text-m-ink"
			><Download size={18} />Download log</a
		>
	</div>
</MSheet>
