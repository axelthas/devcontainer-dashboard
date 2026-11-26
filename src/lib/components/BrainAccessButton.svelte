<script lang="ts">
	import { BrainCircuit, Clock } from 'lucide-svelte';
	import type { ContainerData } from '$lib/types';
	import { formatRemaining, useBrainAccess } from '$lib/brainAccess.svelte';
	import { isEndingSoon } from '$lib/brainAlerts';
	import BrainAccessDialog from './BrainAccessDialog.svelte';

	interface Props {
		container: ContainerData;
	}

	let { container }: Props = $props();

	// Rows also render outside the dashboard page, for example in component tests.
	const access = useBrainAccess();
	const grant = $derived(access?.grantFor(container.id));
	const visible = $derived(
		Boolean(access?.enabled) && (container.state === 'running' || Boolean(grant))
	);
	const ending = $derived(Boolean(grant && access && isEndingSoon(grant, access.now)));
	let open = $state(false);

	/** On the dashboard, show this container's group in the Brain pane; else the dialog. */
	function showGrant() {
		if (grant && access?.focusHandler) access.focus(grant.id);
		else open = true;
	}
</script>

{#if access && visible}
	{#if grant}
		<button
			type="button"
			onclick={showGrant}
			title={ending
				? `Brain access ends soon. Show its work and extend access.`
				: `Brain has shell access as ${grant.user}. Show its work.`}
			class="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium whitespace-nowrap text-[#2e3440] transition-opacity hover:opacity-90 {ending
				? 'bg-[#ebcb8b]'
				: 'bg-[#b48ead]'}"
			data-ending={ending ? '' : undefined}
		>
			{#if ending}<Clock size={12} />{:else}<BrainCircuit size={12} />{/if}
			Brain · {formatRemaining(grant.expiresAt, access.now)}
		</button>
	{:else}
		<button
			type="button"
			onclick={() => (open = true)}
			class="flex items-center gap-1.5 rounded-lg border border-dashed border-[#b48ead]/60 px-2 py-1 text-xs font-medium whitespace-nowrap text-[#b48ead] transition-colors hover:border-solid hover:bg-[#b48ead]/10"
		>
			<BrainCircuit size={12} />
			Grant Brain
		</button>
	{/if}
	{#if open}
		<BrainAccessDialog {access} {container} {grant} onClose={() => (open = false)} />
	{/if}
{/if}
