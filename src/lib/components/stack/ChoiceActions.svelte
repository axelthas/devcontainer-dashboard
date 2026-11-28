<script lang="ts">
	/** Project-level controls. Request feedback does not signal the current mode. */
	import { tick } from 'svelte';
	import { choiceLabel, type ChoiceOutcome } from '$lib/stackKinds/types';
	import { errorMessage, requestJson } from '$lib/requests';
	import RequestError from '../RequestError.svelte';
	import type { PresenterProps } from './types';

	let { view, onChanged }: PresenterProps = $props();
	let busy = $state<string | null>(null);
	let dialog: HTMLDialogElement;
	let pending = $state<{ action: string; option: string; label: string } | null>(null);
	let message = $state('');
	let results = $state<Record<string, ChoiceOutcome>>({});
	/** Prefer a newer result fetched from the server to a local request result. */
	function latestOutcome(action: string) {
		const stored = view.actionState[action];
		const local = results[action];
		return stored && (!local || stored.at > local.at) ? stored : local;
	}
	const blocked = $derived(
		!view.request || (view.instance !== undefined && view.instance.state !== 'ready')
	);

	/** Submit one choice for the current project. */
	async function run(action: string, option: string, confirmed: boolean) {
		if (blocked || busy !== null) return;
		busy = action;
		message = '';
		try {
			const outcome = await requestJson<ChoiceOutcome>('/api/compose/action', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...view.request, action, option, confirmed })
			});
			results = { ...results, [action]: outcome };
			onChanged();
		} catch (cause) {
			message = errorMessage(cause);
		} finally {
			busy = null;
		}
	}

	/** Confirm configured options in a dialog without changing the button label. */
	async function choose(action: string, option: string, label: string, confirm: boolean) {
		if (!confirm) return void run(action, option, false);
		pending = { action, option, label };
		await tick();
		if (dialog?.isConnected && !dialog.open) dialog.showModal();
	}

	/** Close the dialog and submit the confirmed option. */
	function confirmChoice() {
		const choice = pending;
		dialog.close();
		if (choice) void run(choice.action, choice.option, true);
	}
</script>

{#each view.kind.actions ?? [] as action (action.id)}
	{@const outcome = latestOutcome(action.id)}
	<div
		class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm"
		role="group"
		aria-label={action.label}
	>
		<span class="font-semibold">{action.label}</span>
		<div class="flex flex-wrap gap-1 rounded-lg bg-[#eceff4] p-1 dark:bg-[#2e3440]">
			{#each action.options as option (option)}
				{@const label = choiceLabel(action, option)}
				<button
					type="button"
					disabled={blocked || busy !== null}
					onclick={() => void choose(action.id, option, label, action.confirm.includes(option))}
					class="rounded-md px-3 py-1.5 font-medium hover:bg-[#d8dee9] disabled:opacity-50 dark:hover:bg-[#434c5e]"
				>
					{label}
				</button>
			{/each}
		</div>
		<div class="min-w-0 text-xs text-[#4c566a] dark:text-[#d8dee9]" aria-live="polite">
			{#if busy === action.id}
				Sending request…
			{:else if outcome}
				Last request: {choiceLabel(action, outcome.value)} ·
				<time datetime={outcome.at}
					>{new Date(outcome.at).toLocaleTimeString([], {
						hour: '2-digit',
						minute: '2-digit'
					})}</time
				>
				· {outcome.result === 'failed'
					? 'failed'
					: outcome.result === 'partial'
						? 'partial'
						: outcome.readBackPassed
							? 'read-back passed'
							: 'not verified'}
			{:else}
				Current state not verified
			{/if}
		</div>
		{#if outcome?.services?.length && outcome.result !== 'ok'}
			<details class="basis-full text-xs">
				<summary class="cursor-pointer"
					>{outcome.services.filter((item) => item.result === 'ok').length}/{outcome.services
						.length} services succeeded</summary
				>
				<ul class="mt-1 pl-4">
					{#each outcome.services as service (service.service)}
						<li>{service.service}: {service.result}</li>
					{/each}
				</ul>
			</details>
		{/if}
	</div>
{/each}
<RequestError {message} />

<dialog
	bind:this={dialog}
	onclose={() => (pending = null)}
	aria-label="Confirm action"
	class="m-auto w-96 max-w-[calc(100%-2rem)] rounded-xl border border-[#d8dee9] bg-white p-5 text-[#2e3440] backdrop:bg-black/40 dark:border-[#4c566a] dark:bg-[#3b4252] dark:text-[#eceff4]"
>
	{#if pending}
		<h3 class="text-base font-semibold">Request {pending.label}?</h3>
		<p class="mt-2 text-sm">
			This sends the request to the configured services in <strong>{view.project}</strong>.
		</p>
		<div class="mt-5 flex justify-end gap-2">
			<button type="button" class="rounded-md border px-3 py-1.5" onclick={() => dialog.close()}
				>Cancel</button
			>
			<button
				type="button"
				class="rounded-md bg-[#4c6e97] px-3 py-1.5 text-white"
				onclick={confirmChoice}>Confirm</button
			>
		</div>
	{/if}
</dialog>
