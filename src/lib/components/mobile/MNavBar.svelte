<script lang="ts">
	/**
	 * Root screens: the host as context and a large title. Pushed screens: Back and actions;
	 * their title is the first heading of the content, so long names wrap instead of clipping.
	 */
	import { ChevronLeft } from 'lucide-svelte';
	import type { Snippet } from 'svelte';
	import brandIcon from '$lib/assets/favicon.svg';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';

	interface Props {
		/** Large root title. Omit on pushed screens. */
		title?: string;
		/** Back link of a pushed screen, already resolved. */
		back?: { href: string; label: string };
		right?: Snippet;
	}
	let { title, back, right }: Props = $props();
	const dashboard = useMobileDashboard();
</script>

<header
	class="sticky top-0 z-20 bg-m-screen/92 backdrop-blur-xl"
	style:padding-top="env(safe-area-inset-top)"
>
	{#if back}
		<div class="flex min-h-11 items-center justify-between gap-2 px-1">
			<!-- eslint-disable svelte/no-navigation-without-resolve -- the href is already resolved -->
			<a
				href={back.href}
				class="flex min-h-11 min-w-11 items-center pr-2 text-[17px] text-m-frost"
				data-testid="mobile-back"
			>
				<ChevronLeft size={26} strokeWidth={2.2} aria-hidden="true" />
				<span class="max-w-[60vw] truncate">{back.label}</span>
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
			<div class="flex items-center">{@render right?.()}</div>
		</div>
	{:else}
		<div class="px-4 pb-2">
			<div class="flex min-h-11 items-center justify-between">
				<button
					type="button"
					onclick={() => (dashboard.hostSheetOpen = true)}
					class="flex min-h-11 items-center gap-2 rounded-full pr-2"
					aria-label="Host and settings"
					data-testid="host-button"
				>
					<img src={brandIcon} alt="" width="28" height="28" class="size-7" />
					<span class="text-[15px] font-semibold text-m-dim">{dashboard.hostname}</span>
				</button>
				<div class="flex items-center">{@render right?.()}</div>
			</div>
			{#if title}
				<h1 class="mt-0.5 text-[32px] leading-tight font-bold tracking-[-0.02em]">{title}</h1>
			{/if}
		</div>
	{/if}
</header>
