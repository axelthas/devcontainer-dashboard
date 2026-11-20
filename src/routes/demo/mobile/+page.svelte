<script lang="ts">
	/** Production components with fixed, synthetic identities for repeatable visual checks. */
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { provideBrainAccess } from '$lib/brainAccess.svelte';
	import { mobileContainers, mobileWorkspaces, mobileServices } from '$lib/testing/mobileData';
	import DevcontainerRow from '$lib/components/DevcontainerRow.svelte';
	import LocalWorkspaces from '$lib/components/LocalWorkspaces.svelte';
	import ComposeGroupRow from '$lib/components/ComposeGroupRow.svelte';
	const access = provideBrainAccess();
	access.status = { enabled: true, grants: [], executions: [], audit: [] };
	const section = $derived(page.url.searchParams.get('section') ?? 'containers');
	/** Fixture callbacks never start processes or refresh live Docker data. */
	async function refresh() {}
	function terminal() {}
	$effect(() => {
		document.documentElement.classList.add('dark');
	});
</script>

<div class="dark min-h-screen bg-[#2e3440] pb-20 text-[#eceff4]">
	<nav
		aria-label="Sections"
		class="sticky top-0 z-20 grid h-16 grid-cols-3 items-center gap-1 border-b border-[#4c566a] bg-[#2e3440] px-3 text-sm"
	>
		{#each ['containers', 'workspaces', 'services'] as name (name)}
			<a
				class="rounded-xl p-3 text-center capitalize {section === name
					? 'bg-[#88c0d0] text-[#2e3440]'
					: ''}"
				href={resolve(`/demo/mobile?section=${name}`)}>{name}</a
			>
		{/each}
	</nav>
	<main class="mx-auto max-w-5xl p-3">
		{#if section === 'containers'}
			<h1 class="mb-4 text-xl font-bold">Devcontainers</h1>
			<div class="divide-y divide-[#4c566a] rounded-xl border border-[#4c566a] bg-[#3b4252]">
				{#each mobileContainers as container (container.id)}<DevcontainerRow
						{container}
						vscodeSshHost="workstation"
						onRefresh={refresh}
						onOpenTerminal={terminal}
					/>{/each}
			</div>
		{:else if section === 'workspaces'}
			<LocalWorkspaces
				workspaces={mobileWorkspaces}
				containers={[]}
				workspaceRoot="/nonexistent/mobile-fixture"
				vscodeSshHost="workstation"
				onOpenTerminal={terminal}
				onRefreshWorkspaces={refresh}
			/>
		{:else}
			<h1 class="mb-4 text-xl font-bold">Services</h1>
			<div class="rounded-xl border border-[#4c566a] bg-[#3b4252]">
				<ComposeGroupRow
					projectName="polaris-ice"
					containers={mobileServices}
					vscodeSshHost="workstation"
					servicePorts={{ '6904': 'http', '9001': 'http' }}
					serviceAccess="https"
					onRefresh={refresh}
					onOpenTerminal={terminal}
				/>
			</div>
		{/if}
	</main>
</div>
