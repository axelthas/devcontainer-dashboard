<script lang="ts">
	/**
	 * Which services Build and Start use. A tap leaves a service out or adds it back;
	 * services that a selected service depends on stay in and say so.
	 */
	import { Check } from 'lucide-svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useComposeSandbox } from '$lib/mobile/composeSandbox.svelte';
	import MChip from '$lib/components/mobile/MChip.svelte';
	import MGroup from '$lib/components/mobile/MGroup.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';

	const sandbox = useComposeSandbox();
	const inspection = $derived(sandbox.inspection);
	const allChosen = $derived(sandbox.chosen.length === sandbox.serviceNames.length);
	const backHref = $derived(
		resolve('/mobile/workspaces/[workspace]/[repo]/sandbox', {
			workspace: page.params.workspace ?? '',
			repo: page.params.repo ?? ''
		})
	);
</script>

<MNavBar back={{ href: backHref, label: inspection?.projectName ?? 'Sandbox' }}>
	{#snippet right()}
		{#if inspection?.services.length}
			<button
				type="button"
				onclick={() => sandbox.selectAllServices(!allChosen)}
				class="min-h-11 px-3 text-[17px] text-m-frost"
				data-testid="services-all">{allChosen ? 'None' : 'All'}</button
			>
		{/if}
	{/snippet}
</MNavBar>

<div class="px-5 pb-4">
	<h2 class="text-[26px] font-bold">Services</h2>
	<p class="mt-1 text-[15px] leading-snug text-m-dim">
		{#if inspection}
			{sandbox.effective.length} of {sandbox.serviceNames.length} selected. Build and Start use this selection;
			the others keep their state.
		{:else if sandbox.inspecting}
			Checking the configuration…
		{:else}
			{sandbox.inspectError || 'The configuration is not checked yet.'}
		{/if}
	</p>
</div>

{#if inspection?.services.length}
	<MGroup>
		{#each inspection.services as service (service.name)}
			{@const dependency = sandbox.implied.includes(service.name)}
			{@const selected = sandbox.effective.includes(service.name)}
			{@const state = sandbox.serviceState(service.name)}
			<button
				type="button"
				role="checkbox"
				aria-checked={selected}
				aria-disabled={dependency}
				onclick={() => !dependency && sandbox.toggleService(service.name)}
				class="flex min-h-[60px] w-full items-center gap-3 px-4 py-2.5 text-left"
				data-testid="sandbox-service"
			>
				<span
					class="flex size-[26px] shrink-0 items-center justify-center rounded-full border-2 {selected
						? dependency
							? 'border-m-beak bg-m-beak/20 text-m-beak'
							: 'border-m-frost bg-m-frost text-m-on-frost'
						: 'border-m-edge'}"
				>
					{#if selected}<Check size={15} strokeWidth={3} />{/if}
				</span>
				<span class="min-w-0 flex-1 {selected ? '' : 'text-m-dim'}">
					<span class="flex items-center gap-2 text-[17px] [overflow-wrap:anywhere]">
						<span
							class="inline-block size-2 shrink-0 rounded-full {state.running
								? 'bg-m-run'
								: 'bg-m-edge'}"
							role="img"
							aria-label={state.label}
						></span>
						{service.name}
					</span>
					<span
						class="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[13px] [overflow-wrap:anywhere] text-m-dim"
					>
						{#if service.hasBuild}<span class="text-m-warn">build</span>{/if}
						<span class="min-w-0 [overflow-wrap:anywhere]"
							>{service.effectiveImage ?? service.image ?? ''}</span
						>
						{#if service.imagePresent === false}<span class="text-m-glacier">not on host</span>{/if}
					</span>
				</span>
				{#if dependency}<MChip tone="border-m-beak/50 text-m-beak">dependency</MChip>{/if}
			</button>
		{/each}
	</MGroup>
{/if}
