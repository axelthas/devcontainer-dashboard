<script lang="ts">
	import { onMount } from 'svelte';
	import { BrainCircuit, Info, Loader2, ShieldAlert, TriangleAlert, X } from 'lucide-svelte';
	import type { ContainerData } from '$lib/types';
	import {
		BRAIN_GRANT_MINUTES,
		type BrainExposureLevel,
		type BrainGrantMinutes,
		type BrainGrantView,
		type BrainTargetPreview
	} from '$lib/brainTypes';
	import { formatRemaining, type BrainAccess } from '$lib/brainAccess.svelte';
	import { errorMessage } from '$lib/requests';

	interface Props {
		access: BrainAccess;
		container: ContainerData;
		/** Present when Brain already has access: the dialog shows it and offers revocation */
		grant?: BrainGrantView;
		onClose: () => void;
	}

	let { access, container, grant, onClose }: Props = $props();

	const uid = $props.id();
	const LEVEL_CLASS: Record<BrainExposureLevel, string> = {
		danger: 'text-[#bf616a]',
		warning: 'text-[#d08770]',
		info: 'text-[#4c566a] dark:text-[#d8dee9]/70'
	};

	let dialog: HTMLDialogElement | undefined = $state();
	let preview = $state<BrainTargetPreview | null>(null);
	let loading = $state(false);
	let working = $state(false);
	let failure = $state('');
	let minutes = $state<BrainGrantMinutes>(60);
	let acceptRisks = $state(false);

	const shown = $derived<BrainTargetPreview | BrainGrantView | null>(grant ?? preview);
	const needsAcceptance = $derived(
		Boolean(shown?.exposure.some((item) => item.level === 'danger'))
	);
	const canGrant = $derived(
		Boolean(preview) && !grant && !working && (!needsAcceptance || acceptRisks)
	);

	onMount(() => {
		dialog?.showModal();
		if (!grant) void loadPreview();
	});

	/** Inspect the container, so the operator reviews live user, directory and reach. */
	async function loadPreview() {
		loading = true;
		failure = '';
		try {
			preview = await access.preview(container.id);
		} catch (cause) {
			failure = errorMessage(cause);
		} finally {
			loading = false;
		}
	}

	/** Grant the reviewed container run; the server refuses a restarted container. */
	async function confirmGrant() {
		if (!preview || !canGrant) return;
		working = true;
		failure = '';
		try {
			await access.grant({
				containerId: container.id,
				startedAt: preview.startedAt,
				minutes,
				acceptRisks
			});
			dialog?.close();
		} catch (cause) {
			failure = errorMessage(cause);
		} finally {
			working = false;
		}
	}

	/** End the grant; its running commands receive TERM, then KILL. */
	async function revoke() {
		if (!grant || working) return;
		working = true;
		failure = '';
		try {
			await access.revoke(grant.id);
			dialog?.close();
		} catch (cause) {
			failure = errorMessage(cause);
		} finally {
			working = false;
		}
	}

	/** `15 min`, `1 hour`, `4 hours`. */
	function durationLabel(value: number): string {
		if (value < 60) return `${value} min`;
		return value === 60 ? '1 hour' : `${value / 60} hours`;
	}
</script>

<dialog
	bind:this={dialog}
	onclose={onClose}
	aria-labelledby={`${uid}-title`}
	class="m-auto w-full max-w-lg rounded-2xl border border-[#d8dee9] bg-white p-0 text-[#2e3440] shadow-xl backdrop:bg-[#2e3440]/60 dark:border-[#4c566a] dark:bg-[#3b4252] dark:text-[#d8dee9]"
>
	<div
		class="flex items-center justify-between gap-3 border-b border-[#d8dee9] px-5 py-4 dark:border-[#4c566a]"
	>
		<h2 id={`${uid}-title`} class="flex items-center gap-2 text-base font-bold">
			<BrainCircuit size={18} class="text-[#b48ead]" />
			{grant ? 'Brain has shell access' : 'Grant Brain shell access'}
		</h2>
		<button
			type="button"
			aria-label="Close"
			onclick={() => dialog?.close()}
			class="rounded p-1 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] dark:text-[#d8dee9]/60 dark:hover:bg-[#434c5e]"
		>
			<X size={16} />
		</button>
	</div>

	<div class="grid gap-4 px-5 py-4 text-sm">
		{#if loading}
			<p role="status" class="flex items-center gap-2 text-[#4c566a] dark:text-[#d8dee9]/70">
				<Loader2 size={14} class="animate-spin" />
				Inspecting {container.projectName}…
			</p>
		{:else if shown}
			<p>
				Brain can run any command in
				<span class="font-mono">{shown.containerName}</span>
				as <span class="font-mono font-semibold">{shown.user}</span>.
			</p>
			<dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
				<dt class="text-[#4c566a] dark:text-[#d8dee9]/60">User</dt>
				<dd>
					<span class="font-mono">{shown.user}</span>
					<span class="text-[#4c566a] dark:text-[#d8dee9]/60">from {shown.userSource}</span>
				</dd>
				<dt class="text-[#4c566a] dark:text-[#d8dee9]/60">Starts in</dt>
				<dd class="min-w-0 truncate font-mono" title={shown.workdir}>
					{shown.workdir ?? 'the image working directory'}
				</dd>
				{#if grant}
					<dt class="text-[#4c566a] dark:text-[#d8dee9]/60">Expires</dt>
					<dd>
						in {formatRemaining(grant.expiresAt, access.now)}, or when the container stops or
						restarts
					</dd>
					<dt class="text-[#4c566a] dark:text-[#d8dee9]/60">Running</dt>
					<dd>
						{grant.runningExecutions}
						{grant.runningExecutions === 1 ? 'command' : 'commands'}
					</dd>
				{/if}
			</dl>

			<section
				aria-labelledby={`${uid}-reach`}
				class="rounded-lg border p-3 {needsAcceptance
					? 'border-[#bf616a]/40 bg-[#bf616a]/10'
					: 'border-[#d8dee9] bg-[#eceff4] dark:border-[#4c566a] dark:bg-[#2e3440]'}"
			>
				<h3 id={`${uid}-reach`} class="mb-2 text-xs font-semibold">
					Reachable from this container
				</h3>
				{#if shown.exposure.length === 0}
					<p class="text-xs text-[#4c566a] dark:text-[#d8dee9]/70">
						No runtime sockets, extra privileges or credential mounts found.
					</p>
				{:else}
					<ul class="grid gap-1">
						{#each shown.exposure as item (item.message)}
							<li class="flex items-start gap-2 text-xs {LEVEL_CLASS[item.level]}">
								{#if item.level === 'danger'}
									<ShieldAlert size={13} class="mt-px shrink-0" />
								{:else if item.level === 'warning'}
									<TriangleAlert size={13} class="mt-px shrink-0" />
								{:else}
									<Info size={13} class="mt-px shrink-0" />
								{/if}
								<span>{item.message}</span>
							</li>
						{/each}
					</ul>
				{/if}
				{#if needsAcceptance && !grant}
					<label class="mt-3 flex items-center gap-2 text-xs font-medium">
						<input type="checkbox" bind:checked={acceptRisks} class="rounded" />
						I accept this reach
					</label>
				{/if}
			</section>

			{#if !grant}
				<fieldset>
					<legend class="mb-1 text-xs font-semibold">Expires after</legend>
					<div class="flex gap-1">
						{#each BRAIN_GRANT_MINUTES as option (option)}
							<label
								class="cursor-pointer rounded-lg border px-3 py-1 text-xs font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-[#88c0d0] {minutes ===
								option
									? 'border-[#b48ead] bg-[#b48ead]/15 text-[#2e3440] dark:text-[#eceff4]'
									: 'border-[#d8dee9] text-[#4c566a] hover:bg-[#e5e9f0] dark:border-[#4c566a] dark:text-[#d8dee9]/70 dark:hover:bg-[#434c5e]'}"
							>
								<input
									type="radio"
									name={`${uid}-minutes`}
									value={option}
									bind:group={minutes}
									class="sr-only"
								/>
								{durationLabel(option)}
							</label>
						{/each}
					</div>
					<p class="mt-1 text-xs text-[#4c566a] dark:text-[#d8dee9]/60">
						Access also ends when the container stops, restarts or is rebuilt.
					</p>
				</fieldset>
			{/if}
		{/if}

		{#if failure}
			<p role="alert" class="text-xs text-[#bf616a]">{failure}</p>
		{/if}
	</div>

	<div class="flex justify-end gap-2 border-t border-[#d8dee9] px-5 py-3 dark:border-[#4c566a]">
		<button
			type="button"
			onclick={() => dialog?.close()}
			class="rounded-lg border border-[#d8dee9] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[#e5e9f0] dark:border-[#4c566a] dark:hover:bg-[#434c5e]"
		>
			{grant ? 'Close' : 'Cancel'}
		</button>
		{#if grant}
			<button
				type="button"
				disabled={working}
				onclick={() => void revoke()}
				class="flex items-center gap-1.5 rounded-lg bg-[#bf616a] px-3 py-1.5 text-xs font-medium text-[#eceff4] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{#if working}<Loader2 size={12} class="animate-spin" />{/if}
				Revoke and stop commands
			</button>
		{:else}
			<button
				type="button"
				disabled={!canGrant}
				onclick={() => void confirmGrant()}
				class="flex items-center gap-1.5 rounded-lg bg-[#b48ead] px-3 py-1.5 text-xs font-medium text-[#2e3440] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{#if working}
					<Loader2 size={12} class="animate-spin" />
				{:else}
					<BrainCircuit size={12} />
				{/if}
				Grant for {durationLabel(minutes)}
			</button>
		{/if}
	</div>
</dialog>
