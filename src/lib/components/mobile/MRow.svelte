<script lang="ts">
	/**
	 * One list row: at least 52 px high, the whole row is the touch target, and text wraps
	 * instead of clipping. A row with `href` navigates; a row with `onclick` acts.
	 */
	import { ChevronRight } from 'lucide-svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		title: string | Snippet;
		subtitle?: string | Snippet;
		/** Already resolved with `resolve()` by the caller. */
		href?: string;
		onclick?: () => void;
		icon?: Snippet;
		/** Classes of the icon tile, for example `bg-m-frost/15 text-m-frost`. */
		tone?: string;
		trailing?: Snippet;
		chevron?: boolean;
		danger?: boolean;
		mono?: boolean;
		disabled?: boolean;
		testid?: string;
	}
	let {
		title,
		subtitle,
		href,
		onclick,
		icon,
		tone = 'bg-m-raised text-m-frost',
		trailing,
		chevron,
		danger = false,
		mono = false,
		disabled = false,
		testid
	}: Props = $props();

	const showChevron = $derived(chevron ?? Boolean(href));
	const rowClass =
		'flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5 text-left active:bg-m-raised/60';
</script>

{#snippet body()}
	{#if icon}
		<span class="flex size-8 shrink-0 items-center justify-center rounded-[9px] {tone}">
			{@render icon()}
		</span>
	{/if}
	<span class="min-w-0 flex-1">
		<span
			class="block text-[17px] leading-snug [overflow-wrap:anywhere] {danger
				? 'text-m-stop'
				: ''} {mono ? 'font-mono text-[15px]' : ''}"
		>
			{#if typeof title === 'string'}{title}{:else}{@render title()}{/if}
		</span>
		{#if subtitle}
			<span class="mt-0.5 block text-[14px] leading-snug [overflow-wrap:anywhere] text-m-dim">
				{#if typeof subtitle === 'string'}{subtitle}{:else}{@render subtitle()}{/if}
			</span>
		{/if}
	</span>
	{@render trailing?.()}
	{#if showChevron}
		<ChevronRight size={18} class="shrink-0 text-m-dim/70" aria-hidden="true" />
	{/if}
{/snippet}

{#if href && !disabled}
	<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- callers pass resolve() output -->
	<a {href} class={rowClass} data-testid={testid}>{@render body()}</a>
{:else if onclick}
	<button
		type="button"
		{onclick}
		{disabled}
		class="{rowClass} disabled:opacity-50"
		data-testid={testid}>{@render body()}</button
	>
{:else}
	<div class="{rowClass} active:bg-transparent {disabled ? 'opacity-50' : ''}" data-testid={testid}>
		{@render body()}
	</div>
{/if}
