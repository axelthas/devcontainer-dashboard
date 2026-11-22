<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<!-- iOS ignores SVG icons on the home screen; scripts/generate-app-icons.mjs renders this PNG. -->
	<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
	<meta name="apple-mobile-web-app-title" content="DevHarbour" />
	<title>DevHarbour</title>
	<meta
		name="description"
		content="A self-hosted control center for development environments, containers, terminals, and coding tools."
	/>
	<meta name="theme-color" content="#2e3440" />
</svelte:head>

{@render children()}
