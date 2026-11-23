<script lang="ts">
	/** Docker services that are not devcontainers: Compose stacks first, then single containers. */
	import { Boxes, Server } from 'lucide-svelte';
	import { resolve } from '$app/paths';
	import { sandboxVersion } from '$lib/imageReference';
	import { useMobileDashboard, type ComposeStack } from '$lib/mobile/dashboard.svelte';
	import MDot from '$lib/components/mobile/MDot.svelte';
	import MGroup from '$lib/components/mobile/MGroup.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';
	import MRow from '$lib/components/mobile/MRow.svelte';
	import MSearch from '$lib/components/mobile/MSearch.svelte';

	const dashboard = useMobileDashboard();
	let query = $state(dashboard.ui.serviceQuery ?? '');
	$effect(() => {
		dashboard.ui.serviceQuery = query;
	});
	const needle = $derived(query.trim().toLowerCase());
	const stacks = $derived(
		dashboard.stacks.filter(
			(stack) =>
				!needle ||
				stack.name.toLowerCase().includes(needle) ||
				stack.containers.some((c) => (c.composeService ?? c.name).toLowerCase().includes(needle))
		)
	);
	const standalone = $derived(
		dashboard.standalone.filter((c) => !needle || c.name.toLowerCase().includes(needle))
	);

	/** The version a stack runs, as the desktop version chip names it. */
	function version(stack: ComposeStack): string {
		return sandboxVersion(
			stack.name,
			stack.containers.map((c) => ({
				image: c.image,
				service: c.composeService ?? c.name,
				sandboxTag: c.sandboxTag
			}))
		).label;
	}
</script>

<MNavBar title="Services" />
<MSearch bind:value={query} placeholder="Search stacks and services" />
{#if stacks.length === 0 && standalone.length === 0}
	<p class="px-8 py-10 text-center text-[15px] text-m-dim">
		{needle ? 'Nothing matches the search.' : 'No Docker services publish ports.'}
	</p>
{/if}
{#if stacks.length}
	<MGroup title="Compose stacks">
		{#each stacks as stack (stack.name)}
			<MRow
				href={resolve('/mobile/services/[stack]', { stack: stack.name })}
				subtitle={`${stack.running}/${stack.containers.length} running · ${version(stack)}`}
				testid="stack-row"
			>
				{#snippet icon()}<Boxes size={18} />{/snippet}
				{#snippet title()}<span class="font-semibold [overflow-wrap:anywhere]">{stack.name}</span
					>{/snippet}
				{#snippet trailing()}<MDot state={stack.running ? 'running' : 'exited'} />{/snippet}
			</MRow>
		{/each}
	</MGroup>
{/if}
{#if standalone.length}
	<MGroup title="Standalone">
		{#each standalone as container (container.id)}
			{@const ports = Object.keys(container.ports)}
			<MRow
				title={container.name.replace(/^\//, '')}
				subtitle={`${container.state === 'running' ? 'Running' : 'Stopped'}${ports.length ? ` · port ${ports.join(', ')}` : ''}`}
				href={resolve('/mobile/services/container/[id]', { id: container.id })}
			>
				{#snippet icon()}<Server size={18} />{/snippet}
				{#snippet trailing()}<MDot state={container.state} />{/snippet}
			</MRow>
		{/each}
	</MGroup>
{/if}
