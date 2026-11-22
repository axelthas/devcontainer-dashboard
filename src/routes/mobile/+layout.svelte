<script lang="ts">
	/**
	 * Shell of the mobile interface: shared state, the tab bar, the host sheet and toasts.
	 * Screens are separate routes, so Back, deep links and reloads behave like any web page.
	 * The interface reads the same API routes and storage keys as the desktop dashboard.
	 */
	import { page } from '$app/state';
	import { provideBrainAccess } from '$lib/brainAccess.svelte';
	import { trackVisualViewport } from '$lib/visualViewport.svelte';
	import { provideMobileDashboard, type MobileInitialData } from '$lib/mobile/dashboard.svelte';
	import MHostSheet from '$lib/components/mobile/MHostSheet.svelte';
	import MTabBar from '$lib/components/mobile/MTabBar.svelte';
	import { untrack, type Snippet } from 'svelte';

	interface Props {
		data: MobileInitialData;
		children: Snippet;
	}
	let { data, children }: Props = $props();

	// The layout data seeds the state once; polling owns every later update.
	const dashboard = provideMobileDashboard(untrack(() => data));
	const brain = provideBrainAccess();

	$effect(() => {
		dashboard.loadPreferences();
		const stop = dashboard.start();
		let timer: ReturnType<typeof setTimeout>;
		let stopped = false;
		const pollBrain = async () => {
			await brain.refresh().catch(() => {});
			if (!stopped) timer = setTimeout(pollBrain, 5000);
		};
		void pollBrain();
		return () => {
			stopped = true;
			clearTimeout(timer);
			stop();
			brain.dispose();
		};
	});

	// Keyboard inset for the terminal and for sheets with text fields.
	$effect(() => trackVisualViewport());

	/** Terminal screens and the service viewer use the whole screen, without the tab bar. */
	const FULL_SCREEN = [
		'/mobile/terminals/[id]',
		'/mobile/terminals/brain/',
		'/mobile/services/view'
	];

	/** The tab of the current route; the full-screen terminal has none. */
	const section = $derived.by(() => {
		const id = page.route.id ?? '';
		if (FULL_SCREEN.some((prefix) => id.startsWith(prefix))) return null;
		for (const tab of ['containers', 'workspaces', 'services', 'terminals'] as const)
			if (id.startsWith(`/mobile/${tab}`)) return tab;
		return null;
	});
	const fullscreen = $derived(
		FULL_SCREEN.some((prefix) => (page.route.id ?? '').startsWith(prefix))
	);
</script>

<svelte:head>
	<title>DevHarbour</title>
	<meta name="theme-color" content={dashboard.light ? '#eceff4' : '#2e3440'} />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
</svelte:head>

<div
	class="mobile-app min-h-dvh bg-m-screen text-m-ink {dashboard.light ? 'mobile-light' : 'dark'}"
	data-testid="mobile-app"
>
	<!--
		Paint the status-bar strip independently of scrolling headers. It stays opaque when
		iOS composites the top edge and while a page scrolls. Native modal sheets stay above
		it in the top layer. The custom property lets browser tests supply a nonzero inset;
		on a phone, env() remains the source. This strip adds no second layout inset.
	-->
	<div
		class="pointer-events-none fixed inset-x-0 top-0 z-30 bg-m-screen"
		style:height="var(--mobile-safe-area-top, env(safe-area-inset-top, 0px))"
		aria-hidden="true"
		data-testid="mobile-top-safe-area"
	></div>
	<div
		class={fullscreen ? '' : 'pb-[calc(76px+env(safe-area-inset-bottom))]'}
		style:padding-left="env(safe-area-inset-left)"
		style:padding-right="env(safe-area-inset-right)"
	>
		{@render children()}
	</div>
	{#if !fullscreen}
		<MTabBar current={section} terminalCount={dashboard.sessions.length} />
	{/if}
	<MHostSheet />
	{#if dashboard.toastMessage}
		<div
			role="status"
			class="pointer-events-none fixed inset-x-4 z-50 mx-auto w-fit max-w-[calc(100vw-32px)] animate-[m-fade-up_200ms_ease-out] rounded-full bg-m-ink px-4 py-2 text-center text-[15px] font-medium text-m-screen shadow-lg"
			style:top="calc(env(safe-area-inset-top) + 56px)"
			data-testid="mobile-toast"
		>
			{dashboard.toastMessage}
		</div>
	{/if}
</div>
