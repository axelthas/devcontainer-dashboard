<script lang="ts">
	/** One Compose stack: its state, whole-stack actions, and its services. */
	import { Loader2, Network, Play, RotateCw, Square, Tag, TriangleAlert } from 'lucide-svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { getPortLabel } from '$lib/portConfig';
	import { sandboxVersion } from '$lib/imageReference';
	import { errorMessage, requestJson } from '$lib/requests';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';
	import MBanner from '$lib/components/mobile/MBanner.svelte';
	import MButton from '$lib/components/mobile/MButton.svelte';
	import MChip from '$lib/components/mobile/MChip.svelte';
	import MDot from '$lib/components/mobile/MDot.svelte';
	import MGroup from '$lib/components/mobile/MGroup.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';
	import MRow from '$lib/components/mobile/MRow.svelte';

	const dashboard = useMobileDashboard();
	const stack = $derived(dashboard.stacks.find((s) => s.name === page.params.stack));
	const networks = $derived(
		dashboard.networks.filter((network) => stack && network.projects.includes(stack.name))
	);
	let busy = $state<'start' | 'stop' | 'restart' | null>(null);
	let error = $state('');
	const version = $derived(
		stack
			? sandboxVersion(
					stack.name,
					stack.containers.map((c) => ({
						image: c.image,
						service: c.composeService ?? c.name,
						sandboxTag: c.sandboxTag
					}))
				).label
			: ''
	);

	/** Run one action on every container that it changes, as the desktop group row does. */
	async function all(action: 'start' | 'stop' | 'restart') {
		if (!stack || busy) return;
		const targets = stack.containers.filter((c) =>
			action === 'start' ? c.state !== 'running' : c.state === 'running'
		);
		busy = action;
		error = '';
		try {
			const results = await Promise.allSettled(
				targets.map((c) => requestJson(`/api/containers/${c.id}/${action}`, { method: 'POST' }))
			);
			const failed = results.filter((result) => result.status === 'rejected');
			if (failed.length)
				error = `${failed.length} of ${targets.length} failed. ${errorMessage((failed[0] as PromiseRejectedResult).reason)}`;
			await dashboard.refreshContainers().catch(() => {});
		} finally {
			busy = null;
		}
	}
</script>

<MNavBar back={{ href: resolve('/mobile/services'), label: 'Services' }} />

{#if !stack}
	<p class="px-8 py-12 text-center text-[16px] text-m-dim">This stack has no containers now.</p>
{:else}
	<div class="px-5 pb-5">
		<div class="flex items-center gap-2 text-[15px] text-m-dim">
			<MDot state={stack.running ? 'running' : 'exited'} busy={Boolean(busy)} />{stack.running} of {stack
				.containers.length} running
		</div>
		<h2 class="mt-1 text-[26px] leading-tight font-bold [overflow-wrap:anywhere]">{stack.name}</h2>
		<div class="mt-2 flex flex-wrap gap-1.5">
			<MChip tone="border-m-frost/50 text-m-frost"><Tag size={12} />{version}</MChip>
		</div>
	</div>
	{#if error}
		<MBanner
			icon={TriangleAlert}
			tone="bg-m-stop/15 text-m-stop"
			title="Not every container changed"
			detail={error}
		/>
	{/if}
	<div class="mx-4 mb-6 grid grid-cols-2 gap-2">
		{#if stack.running < stack.containers.length}
			<div class={stack.running ? '' : 'col-span-2'}>
				<MButton onclick={() => void all('start')} disabled={Boolean(busy)} testid="stack-start">
					{#if busy === 'start'}<Loader2 size={18} class="animate-spin" />{:else}<Play
							size={18}
							class="fill-current"
						/>{/if}
					Start {stack.containers.length - stack.running}
				</MButton>
			</div>
		{/if}
		{#if stack.running}
			{#if stack.running === stack.containers.length}
				<MButton tone="plain" onclick={() => void all('restart')} disabled={Boolean(busy)}>
					{#if busy === 'restart'}<Loader2 size={18} class="animate-spin" />{:else}<RotateCw
							size={18}
						/>{/if}Restart all
				</MButton>
			{/if}
			<MButton
				tone="danger"
				onclick={() => void all('stop')}
				disabled={Boolean(busy)}
				testid="stack-stop"
			>
				{#if busy === 'stop'}<Loader2 size={18} class="animate-spin" />{:else}<Square
						size={16}
						class="fill-current"
					/>{/if}Stop all
			</MButton>
		{/if}
	</div>
	<MGroup
		title={`Services · ${stack.containers.length}`}
		footer="Pull, build and versions live in the sandbox of the repository that owns the stack."
	>
		{#each stack.containers as container (container.id)}
			{@const ports = Object.keys(container.ports)}
			<MRow
				title={container.composeService ?? container.name.replace(/^\//, '')}
				subtitle={ports.length ? ports.map(getPortLabel).join(' · ') : 'No published ports'}
				tone="bg-transparent"
				href={resolve('/mobile/services/container/[id]', { id: container.id })}
				testid="stack-service"
			>
				{#snippet icon()}<MDot state={container.state} />{/snippet}
			</MRow>
		{/each}
	</MGroup>
	{#if networks.length}
		<MGroup title="Networks">
			{#each networks as network (network.name)}
				{@const devcontainers = network.endpoints.filter(
					(endpoint) => endpoint.isDevcontainer
				).length}
				<MRow
					title={network.name}
					subtitle={`${network.subnet ?? 'No subnet'} · ${devcontainers} ${devcontainers === 1 ? 'devcontainer' : 'devcontainers'} connected`}
					tone="bg-m-glacier/15 text-m-glacier"
				>
					{#snippet icon()}<Network size={18} />{/snippet}
				</MRow>
			{/each}
		</MGroup>
	{/if}
{/if}
