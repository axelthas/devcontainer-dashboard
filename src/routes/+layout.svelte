<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Devcontainer Dashboard</title>
</svelte:head>

{#if page.url.pathname === '/'}
	<nav aria-label="Local AI" class="bg-[#3b4252] px-6 py-2 text-right text-sm text-[#88c0d0]">
		<a class="underline" href={resolve('/ai')}>Local AI: OpenCode and OpenChamber</a>
	</nav>
{/if}

{@render children()}
