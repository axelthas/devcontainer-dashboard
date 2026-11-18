<script lang="ts">
	import { BrainCircuit } from 'lucide-svelte';
	import type { ContainerData } from '$lib/types';
	import { formatRemaining, useBrainAccess } from '$lib/brainAccess.svelte';
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
	let open = $state(false);
</script>

{#if access && visible}
	{#if grant}
		<button
			type="button"
			onclick={() => (open = true)}
			title={`Brain has shell access as ${grant.user}`}
			class="flex items-center gap-1.5 rounded-lg bg-[#b48ead] px-2 py-1 text-xs font-medium whitespace-nowrap text-[#2e3440] transition-opacity hover:opacity-90"
		>
			<BrainCircuit size={12} />
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
