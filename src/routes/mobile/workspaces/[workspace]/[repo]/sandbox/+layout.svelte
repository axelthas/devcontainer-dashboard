<script lang="ts">
	/** The sandbox screens of one repository share one selection and one configuration check. */
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';
	import MSandboxProvider from '$lib/components/mobile/MSandboxProvider.svelte';

	let { children }: { children: Snippet } = $props();
	const dashboard = useMobileDashboard();
	const key = $derived(page.params.workspace ?? '');
	const repo = $derived(
		dashboard.workspace(key)?.repos.find((candidate) => candidate.name === page.params.repo)
	);
</script>

{#if repo?.composeFiles?.length}
	{#key repo.path}
		<MSandboxProvider {repo}>{@render children()}</MSandboxProvider>
	{/key}
{:else}
	<MNavBar
		back={{
			href: resolve('/mobile/workspaces/[workspace]', { workspace: key }),
			label: 'Workspace'
		}}
	/>
	<p class="px-8 py-12 text-center text-[16px] text-m-dim">
		This repository has no Compose sandbox.
	</p>
{/if}
