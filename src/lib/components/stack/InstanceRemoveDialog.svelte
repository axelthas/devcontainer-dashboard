<script lang="ts">
	/** Remove one instance from Docker Services through the preview and token. Volumes stay. */
	import { Loader } from 'lucide-svelte';
	import { errorMessage, requestJson } from '$lib/requests';
	import type { ComposeInstanceRemovalPreview, RemovalResult } from '$lib/types';
	import RequestError from '../RequestError.svelte';

	let {
		project,
		onClose,
		onRemoved
	}: { project: string; onClose: () => void; onRemoved: () => void } = $props();
	let preview = $state<ComposeInstanceRemovalPreview | null>(null);
	let results = $state<RemovalResult[] | null>(null);
	let released = $state(true);
	let busy = $state(true);
	let message = $state('');

	/** Read the preview when the dialog opens. */
	async function load(name: string) {
		busy = true;
		try {
			preview = await requestJson<ComposeInstanceRemovalPreview>(
				`/api/compose/instances/remove?project=${encodeURIComponent(name)}`
			);
		} catch (cause) {
			message = errorMessage(cause);
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		void load(project);
	});

	/** Apply the previewed removal. */
	async function remove() {
		if (!preview) return;
		busy = true;
		message = '';
		try {
			const result = await requestJson<{ results: RemovalResult[]; released: boolean }>(
				'/api/compose/instances/remove',
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ project: preview.project, token: preview.token })
				}
			);
			results = result.results;
			released = result.released;
			onRemoved();
		} catch (cause) {
			message = errorMessage(cause);
		} finally {
			busy = false;
		}
	}
</script>

<div
	role="alertdialog"
	aria-label={`Remove instance ${project}`}
	class="border-b border-[#bf616a]/30 bg-[#bf616a]/5 px-5 py-3 text-xs text-[#2e3440] dark:text-[#d8dee9]"
>
	<p class="font-semibold">Remove instance {project}?</p>
	{#if results}
		<ul class="mt-1">
			{#each results as item (`${item.kind}:${item.name}`)}
				<li>{item.kind} {item.name}: {item.result}{item.reason ? ` (${item.reason})` : ''}</li>
			{/each}
		</ul>
		{#if !released}<p class="mt-1 text-[#d08770]">
				The instance keeps its slot until removal completes.
			</p>{/if}
	{:else if preview}
		<p>
			Removes {preview.containers.length} containers, {preview.networks.filter(
				(network) => network.attached.length === 0
			).length}
			networks and the instance files. Keeps {preview.volumes.length} volumes, images and source files.
		</p>
	{/if}
	<RequestError {message} />
	<div class="mt-2 flex gap-2">
		{#if !results}
			<button
				type="button"
				onclick={() => void remove()}
				disabled={busy || !preview}
				class="flex items-center gap-1 rounded-lg bg-[#bf616a] px-2.5 py-1 font-medium text-white disabled:opacity-50"
			>
				{#if busy}<Loader size={12} class="animate-spin" />{/if}
				Remove
			</button>
		{/if}
		<button type="button" onclick={onClose} class="rounded-lg px-2.5 py-1 font-medium"
			>{results ? 'Close' : 'Cancel'}</button
		>
	</div>
</div>
