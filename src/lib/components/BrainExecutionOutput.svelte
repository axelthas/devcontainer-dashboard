<script lang="ts">
	import type { BrainOutputView } from '$lib/brainTypes';
	import { errorMessage, requestJson } from '$lib/requests';

	interface Props {
		executionId: string;
		/** One command of a shell: show only that command's output */
		commandId?: string;
		/** Taller box for a screen that shows only this output */
		tall?: boolean;
	}

	let { executionId, commandId, tall = false }: Props = $props();

	/** Characters kept in the browser; the server retains more. */
	const MAX_SHOWN = 200_000;
	let text = $state('');
	let truncated = $state(false);
	let failure = $state('');

	// Follow output with an absolute cursor while the command runs; stop when it settles.
	// The panel mounts one viewer per execution, so the ID never changes for an instance.
	$effect(() => {
		const id = executionId;
		const command = commandId;
		let stopped = false;
		let cursor: number | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		async function poll() {
			try {
				const query = [
					command ? `command=${encodeURIComponent(command)}` : '',
					cursor === undefined ? '' : `cursor=${cursor}`
				]
					.filter(Boolean)
					.join('&');
				const view = await requestJson<BrainOutputView>(
					`/api/brain/executions/${encodeURIComponent(id)}${query ? `?${query}` : ''}`
				);
				if (stopped) return;
				const combined = text + view.text;
				truncated ||= view.truncatedBefore || combined.length > MAX_SHOWN;
				text = combined.slice(-MAX_SHOWN);
				cursor = view.nextCursor;
				failure = '';
				const active = view.status === 'running' || view.status === 'stopping';
				if (view.more) timer = setTimeout(poll, 0);
				else if (active) timer = setTimeout(poll, 2000);
			} catch (cause) {
				if (stopped) return;
				failure = errorMessage(cause);
				timer = setTimeout(poll, 5000);
			}
		}
		void poll();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	});
</script>

<div class="grid min-w-0 grid-cols-1 gap-1">
	{#if truncated}
		<p class="text-xs text-[#4c566a] dark:text-[#d8dee9]/60">Earlier output was dropped.</p>
	{/if}
	<pre
		aria-label="Command output"
		class="{tall
			? 'max-h-[55dvh] text-[13px]'
			: 'max-h-[min(16rem,40dvh)] text-xs'} min-w-0 overflow-auto rounded-lg bg-[#2e3440] p-3 font-mono [overflow-wrap:anywhere] whitespace-pre-wrap text-[#d8dee9]">{text ||
			'No output yet.'}</pre>
	{#if failure}
		<p role="alert" class="text-xs text-[#bf616a]">{failure}</p>
	{/if}
</div>
