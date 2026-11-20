<script lang="ts">
	/** Confirmation inside a sheet: what happens, what stays, and one explicit action. */
	import { Check, Loader2, TriangleAlert } from 'lucide-svelte';
	import MButton from './MButton.svelte';
	import MGroup from './MGroup.svelte';
	import MRow from './MRow.svelte';

	interface Props {
		title: string;
		body: string;
		action: string;
		tone?: 'danger-fill' | 'warn';
		keeps?: string[];
		busy?: boolean;
		error?: string;
		onConfirm: () => void;
		onCancel: () => void;
	}
	let {
		title,
		body,
		action,
		tone = 'danger-fill',
		keeps = [],
		busy = false,
		error = '',
		onConfirm,
		onCancel
	}: Props = $props();
</script>

<div class="px-4">
	<div
		class="mb-4 flex items-start gap-3 rounded-[14px] p-4 {tone === 'warn'
			? 'bg-m-warn/12 text-m-warn'
			: 'bg-m-stop/12 text-m-stop'}"
	>
		<TriangleAlert size={22} class="mt-0.5 shrink-0" aria-hidden="true" />
		<div class="min-w-0">
			<div class="text-[17px] font-semibold [overflow-wrap:anywhere]">{title}</div>
			<p class="mt-1 text-[15px] leading-snug text-m-ink/85">{body}</p>
		</div>
	</div>
</div>
{#if keeps.length}
	<MGroup title="Kept">
		{#each keeps as keep (keep)}
			<MRow title={keep} tone="bg-m-run/15 text-m-run">
				{#snippet icon()}<Check size={17} />{/snippet}
			</MRow>
		{/each}
	</MGroup>
{/if}
{#if error}
	<p role="alert" class="mx-5 mb-3 text-[15px] text-m-stop">{error}</p>
{/if}
<div class="grid gap-2 px-4">
	<MButton {tone} onclick={onConfirm} disabled={busy} testid="confirm-action">
		{#if busy}<Loader2 size={18} class="animate-spin" />{/if}{action}
	</MButton>
	<MButton tone="plain" onclick={onCancel}>Cancel</MButton>
</div>
