<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { trackVisualViewport } from '$lib/visualViewport.svelte';

	let { children } = $props();

	// One app-wide tracker: phone panels stay above the on-screen keyboard.
	$effect(() => trackVisualViewport());
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>DevHarbour</title>
	<meta
		name="description"
		content="A self-hosted control center for development environments, containers, terminals, and coding tools."
	/>
	<meta name="theme-color" content="#2e3440" />
</svelte:head>

{@render children()}
