<script lang="ts">
	/** Declared choice actions of a kind, for example modes. Sends the action id and option only. */
	import { Loader } from 'lucide-svelte';
	import { errorMessage, requestJson } from '$lib/requests';
	import RequestError from '../RequestError.svelte';
	import type { PresenterProps } from './types';

	let { view, onChanged }: PresenterProps = $props();
	let busy = $state<string | null>(null);
	let pending = $state<string | null>(null);
	let message = $state('');
	let results = $state<Record<string, { value: string; result: string }>>({});
	const values = $derived({ ...view.actionState, ...results });
	const blocked = $derived(
		!view.request || (view.instance !== undefined && view.instance.state !== 'ready')
	);

	/** Run one option; a confirmation option needs a second click on the same button. */
	async function run(action: string, option: string, confirm: boolean) {
		const key = `${action}:${option}`;
		if (confirm && pending !== key) {
			pending = key;
			return;
		}
		pending = null;
		busy = key;
		message = '';
		try {
			const result = await requestJson<{ result: string }>('/api/compose/action', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...view.request, action, option, confirmed: confirm })
			});
			results = { ...results, [action]: { value: option, result: result.result } };
			onChanged();
		} catch (cause) {
			message = errorMessage(cause);
		} finally {
			busy = null;
		}
	}
</script>

{#each view.kind.actions ?? [] as action (action.id)}
	<div class="flex shrink-0 items-center gap-1 text-xs" role="group" aria-label={action.label}>
		<span class="hidden font-semibold text-[#4c566a] lg:inline dark:text-[#d8dee9]/70"
			>{action.label}</span
		>
		{#each action.options as option (option)}
			{@const confirm = action.confirm.includes(option)}
			{@const current = values[action.id]?.value === option}
			<button
				type="button"
				aria-pressed={current}
				disabled={blocked || busy !== null}
				onclick={() => void run(action.id, option, confirm)}
				title={confirm ? 'Needs confirmation' : undefined}
				class="rounded-lg border px-2 py-0.5 font-medium disabled:opacity-50 {current
					? 'border-[#5e81ac] bg-[#5e81ac] text-white'
					: 'border-[#d8dee9] text-[#2e3440] dark:border-[#4c566a] dark:text-[#d8dee9]'}"
			>
				{#if busy === `${action.id}:${option}`}<Loader size={10} class="inline animate-spin" />{/if}
				{pending === `${action.id}:${option}` ? `Confirm ${option}` : option}
			</button>
		{/each}
		{#if values[action.id] && values[action.id].result !== 'ok'}
			<span class="text-[#d08770]">{values[action.id].result}</span>
		{/if}
	</div>
{/each}
{#if message}<div class="w-full"><RequestError {message} /></div>{/if}
