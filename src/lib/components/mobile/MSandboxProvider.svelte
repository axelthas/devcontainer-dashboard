<script lang="ts">
	/** Owns the sandbox state of one repository while any sandbox screen is open. */
	import type { Snippet } from 'svelte';
	import { ComposeSandbox, provideComposeSandbox } from '$lib/mobile/composeSandbox.svelte';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';
	import type { RepositoryData } from '$lib/types';

	interface Props {
		repo: RepositoryData;
		children: Snippet;
	}
	let { repo, children }: Props = $props();
	const dashboard = useMobileDashboard();
	provideComposeSandbox(
		new ComposeSandbox({
			repo: () => repo,
			onRefresh: () => dashboard.refreshWorkspaces(),
			onRefreshContainers: () => dashboard.refreshContainers()
		})
	);
</script>

{@render children()}
