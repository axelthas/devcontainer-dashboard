<script lang="ts">
	/**
	 * Remove a whole Compose sandbox after a live preview. The server recomputes the preview
	 * at removal time; a changed resource set returns 409, and the dialog shows the new
	 * preview for another review. Volumes, images, and source files always stay.
	 */
	import { onMount } from 'svelte';
	import {
		Check,
		CircleMinus,
		Loader2,
		ShieldCheck,
		Trash2,
		TriangleAlert,
		X
	} from 'lucide-svelte';
	import { errorMessage, RequestError, requestJson } from '$lib/requests';
	import type { RemovalResult, SandboxRemovalPreview } from '$lib/types';

	interface Props {
		project: string;
		onClose: () => void;
		/** Called after a removal request returns, also when some resources failed */
		onRemoved: () => void;
	}
	let { project, onClose, onRemoved }: Props = $props();

	const uid = $props.id();
	let dialog: HTMLDialogElement | undefined = $state();
	let preview = $state<SandboxRemovalPreview | null>(null);
	let results = $state<RemovalResult[] | null>(null);
	let loading = $state(false);
	let working = $state(false);
	let stale = $state(false);
	let failure = $state('');

	const freeNetworks = $derived(preview?.networks.filter((n) => n.attached.length === 0) ?? []);
	const keptNetworks = $derived(preview?.networks.filter((n) => n.attached.length > 0) ?? []);
	const failed = $derived(results?.filter((item) => item.result === 'failed').length ?? 0);

	onMount(() => {
		dialog?.showModal();
		void load();
	});

	/** Read the live resource set and its token. */
	async function load() {
		loading = true;
		failure = '';
		try {
			preview = await requestJson<SandboxRemovalPreview>(
				`/api/compose/remove?project=${encodeURIComponent(project)}`
			);
		} catch (cause) {
			preview = null;
			failure = errorMessage(cause);
		} finally {
			loading = false;
		}
	}

	/** Remove with the token of the reviewed preview. A stale preview is shown again. */
	async function remove() {
		if (!preview || working) return;
		working = true;
		failure = '';
		try {
			const body = await requestJson<{ results: RemovalResult[] }>('/api/compose/remove', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ project, token: preview.token })
			});
			results = body.results;
			stale = false;
			onRemoved();
		} catch (cause) {
			if (cause instanceof RequestError && cause.status === 409 && /changed/i.test(cause.message)) {
				stale = true;
				await load();
			} else {
				failure = errorMessage(cause);
			}
		} finally {
			working = false;
		}
	}

	/** Escape must not close the dialog while removal runs. */
	function cancel(event: Event) {
		if (working) event.preventDefault();
	}
</script>

<dialog
	bind:this={dialog}
	onclose={onClose}
	oncancel={cancel}
	aria-labelledby={`${uid}-title`}
	class="m-auto w-full max-w-lg rounded-2xl border border-[#d8dee9] bg-white p-0 text-[#2e3440] shadow-xl backdrop:bg-[#2e3440]/60 dark:border-[#4c566a] dark:bg-[#3b4252] dark:text-[#d8dee9]"
>
	<div
		class="flex items-center justify-between gap-3 border-b border-[#d8dee9] px-5 py-4 dark:border-[#4c566a]"
	>
		<h2 id={`${uid}-title`} class="flex flex-wrap items-center gap-2 text-base font-bold">
			<Trash2 size={18} class="text-[#bf616a]" />
			{results ? 'Sandbox removed' : 'Remove sandbox'}
			<span class="font-mono">{project}</span>
			{#if preview && preview.containers.length > 0}
				<span
					class="rounded-full border border-[#8fbcbb]/50 bg-[#8fbcbb]/15 px-2 font-mono text-xs text-[#4f8584] dark:text-[#8fbcbb]"
					>{preview.version}</span
				>
			{/if}
		</h2>
		<button
			type="button"
			aria-label="Close"
			disabled={working}
			onclick={() => dialog?.close()}
			class="rounded p-1 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] disabled:opacity-50 dark:text-[#d8dee9]/60 dark:hover:bg-[#434c5e]"
		>
			<X size={16} />
		</button>
	</div>

	<div class="grid gap-4 px-5 py-4 text-sm">
		{#if preview?.source}
			<p class="text-xs text-[#4c566a] dark:text-[#d8dee9]/70">
				Source: <span class="font-mono break-all">{preview.source}</span>
			</p>
		{/if}

		{#if loading}
			<p role="status" class="flex items-center gap-2 text-[#4c566a] dark:text-[#d8dee9]/70">
				<Loader2 size={14} class="animate-spin" />
				Reading {project} from Docker…
			</p>
		{/if}

		{#if stale}
			<p
				role="alert"
				class="flex items-start gap-2 rounded-lg border border-[#ebcb8b]/50 bg-[#ebcb8b]/10 px-3 py-2 text-xs"
			>
				<TriangleAlert size={14} class="mt-0.5 shrink-0 text-[#d08770]" />
				<span
					><strong>The sandbox changed after the preview.</strong> Nothing was removed. Review the list
					again.</span
				>
			</p>
		{/if}

		{#if results}
			<ul class="grid gap-1 text-xs" aria-label="Removal results">
				{#each results as item (`${item.kind}:${item.name}`)}
					<li class="flex flex-wrap items-center gap-x-2">
						{#if item.result === 'removed'}
							<Check size={13} class="text-[#a3be8c]" />
						{:else if item.result === 'kept'}
							<CircleMinus size={13} class="text-[#d08770]" />
						{:else}
							<TriangleAlert size={13} class="text-[#bf616a]" />
						{/if}
						<span class="font-mono">{item.name}</span>
						<span class="text-[#4c566a] dark:text-[#d8dee9]/70"
							>{item.result}{item.reason ? `: ${item.reason}` : ''}</span
						>
					</li>
				{/each}
			</ul>
			{#if failed > 0}
				<p role="alert" class="text-xs text-[#bf616a]">
					{failed}
					{failed === 1 ? 'resource was' : 'resources were'} not removed. Check them in Docker Services.
				</p>
			{/if}
		{:else if preview}
			{#if preview.containers.length > 0}
				<div class="grid gap-1">
					<p class="flex items-center gap-1.5 text-xs font-semibold text-[#bf616a]">
						<Trash2 size={13} />Removes {preview.containers.length}
						{preview.containers.length === 1 ? 'container' : 'containers'}
					</p>
					<ul class="grid gap-0.5 pl-5 text-xs">
						{#each preview.containers as container (container.id)}
							<li>
								<span class="font-mono">{container.name}</span>
								<span class="text-[#4c566a] dark:text-[#d8dee9]/70">{container.state}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
			{#if freeNetworks.length > 0}
				<div class="grid gap-1">
					<p class="flex items-center gap-1.5 text-xs font-semibold text-[#bf616a]">
						<Trash2 size={13} />Removes networks
					</p>
					<ul class="grid gap-0.5 pl-5 text-xs">
						{#each freeNetworks as network (network.id)}
							<li class="font-mono">{network.name}</li>
						{/each}
					</ul>
				</div>
			{/if}
			<div
				class="grid gap-1 rounded-lg border border-[#a3be8c]/40 bg-[#a3be8c]/10 px-3 py-2 text-xs"
			>
				<p class="flex items-center gap-1.5 font-semibold text-[#a3be8c]">
					<ShieldCheck size={13} />Keeps
				</p>
				<ul class="grid gap-0.5 pl-5">
					{#each keptNetworks as network (network.id)}
						<li>
							<span class="font-mono">{network.name}</span>
							<span class="text-[#4c566a] dark:text-[#d8dee9]/70"
								>{network.attached.join(', ')} attached</span
							>
						</li>
					{/each}
					{#each preview.volumes as volume (volume)}
						<li>
							<span class="font-mono">{volume}</span>
							<span class="text-[#4c566a] dark:text-[#d8dee9]/70">volume</span>
						</li>
					{/each}
					<li>All images and all source files</li>
				</ul>
			</div>
		{/if}

		{#if failure}
			<p role="alert" class="text-xs text-[#bf616a]">{failure}</p>
		{/if}
	</div>

	<div class="flex justify-end gap-2 border-t border-[#d8dee9] px-5 py-3 dark:border-[#4c566a]">
		<button
			type="button"
			disabled={working}
			onclick={() => dialog?.close()}
			class="rounded-lg border border-[#d8dee9] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[#e5e9f0] disabled:opacity-50 dark:border-[#4c566a] dark:hover:bg-[#434c5e]"
		>
			{results ? 'Close' : 'Cancel'}
		</button>
		{#if !results}
			<button
				type="button"
				disabled={!preview || loading || working}
				onclick={() => void remove()}
				class="flex items-center gap-1.5 rounded-lg bg-[#bf616a] px-3 py-1.5 text-xs font-medium text-[#eceff4] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{#if working}
					<Loader2 size={12} class="animate-spin" />
				{:else}
					<Trash2 size={12} />
				{/if}
				Remove sandbox
			</button>
		{/if}
	</div>
</dialog>
