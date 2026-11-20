<script lang="ts">
	/**
	 * Bottom sheet for rare and destructive actions. A modal dialog: it traps focus, Escape
	 * and a tap on the dimmed screen close it, and it stays above the on-screen keyboard.
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		open: boolean;
		title: string;
		onClose: () => void;
		testid?: string;
		children: Snippet;
	}
	let { open, title, onClose, testid, children }: Props = $props();
	let dialog: HTMLDialogElement | undefined = $state();
	const uid = $props.id();

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});

	/** A click on the dialog element itself is a click on the backdrop. */
	function backdropClick(event: MouseEvent) {
		if (event.target === dialog) onClose();
	}
</script>

<dialog
	bind:this={dialog}
	aria-labelledby="{uid}-title"
	data-testid={testid}
	onclose={() => open && onClose()}
	onclick={backdropClick}
	class="m-0 mt-auto max-h-[88dvh] w-full max-w-none overflow-hidden rounded-t-[22px] bg-m-screen p-0 text-m-ink backdrop:bg-black/50 open:flex open:animate-[m-sheet-up_300ms_cubic-bezier(0.32,0.72,0,1)] open:flex-col"
	style:margin-bottom="var(--keyboard-inset, 0px)"
>
	{#if open}
		<div class="shrink-0 pt-2">
			<div class="mx-auto h-[5px] w-9 rounded-full bg-m-edge" aria-hidden="true"></div>
			<div class="flex min-h-12 items-center justify-between gap-3 px-5">
				<h2 id="{uid}-title" class="min-w-0 truncate text-[17px] font-semibold">{title}</h2>
				<button
					type="button"
					onclick={onClose}
					class="min-h-11 shrink-0 px-1 text-[17px] font-semibold text-m-frost">Done</button
				>
			</div>
		</div>
		<div
			class="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-1"
			style:padding-bottom="max(16px, env(safe-area-inset-bottom))"
		>
			{@render children()}
		</div>
	{/if}
</dialog>
