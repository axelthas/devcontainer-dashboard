<script lang="ts">
	/**
	 * Bottom sheet for choices, forms and destructive actions. A modal dialog that isolates
	 * the page behind it:
	 *
	 * - Focus: `showModal()` makes the page inert; focus starts on the sheet title, so no
	 *   text field opens the on-screen keyboard; Close returns focus to the opener.
	 * - Scrolling: the page is locked at its position and touch drags that the sheet content
	 *   cannot take are cancelled, so they never move the page.
	 * - Escape, Done and a tap on the dimmed screen close the sheet. The sheet stays above
	 *   the on-screen keyboard.
	 */
	import { ChevronLeft } from 'lucide-svelte';
	import type { Snippet } from 'svelte';
	import { guardSheetTouches, lockPageScroll } from '$lib/mobile/sheetIsolation';

	interface Props {
		open: boolean;
		title: string;
		onClose: () => void;
		/** Prevent dismissal during a write whose result is not known yet. */
		closeDisabled?: boolean;
		/** A step back inside the sheet, for sheets with more than one step. */
		back?: { label: string; onclick: () => void };
		testid?: string;
		children: Snippet;
	}
	let { open, title, onClose, closeDisabled = false, back, testid, children }: Props = $props();
	let dialog: HTMLDialogElement | undefined = $state();
	const uid = $props.id();

	/** Open the dialog with the page isolated; the cleanup closes it and undoes everything. */
	$effect(() => {
		const element = dialog;
		if (!element || !open) return;
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const release = lockPageScroll();
		const unguard = guardSheetTouches(element);
		if (!element.open) element.showModal();
		element.querySelector<HTMLElement>('[data-sheet-title]')?.focus({ preventScroll: true });
		return () => {
			unguard();
			if (element.open) element.close();
			release();
			// The opener can be gone after a navigation, or be behind a sheet that is still open.
			const top = document.querySelector('dialog[open]');
			if (opener?.isConnected && (!top || top.contains(opener)))
				opener.focus({ preventScroll: true });
		};
	});

	/**
	 * Escape closes the dialog natively; report it so the owner clears its state.
	 * The `close` event is queued, so it can arrive after the sheet opened again: a quick
	 * Done and reopen. Only a dialog that is still closed reports the close.
	 */
	function closed() {
		if (open && !dialog?.open) onClose();
	}

	/** A click on the dialog element itself is a click on the backdrop. */
	function backdropClick(event: MouseEvent) {
		if (!closeDisabled && event.target === dialog) onClose();
	}
</script>

<dialog
	bind:this={dialog}
	aria-labelledby="{uid}-title"
	data-testid={testid}
	onclose={closed}
	oncancel={(event) => {
		if (closeDisabled) event.preventDefault();
	}}
	onclick={backdropClick}
	class="m-0 mt-auto max-h-[88dvh] w-full max-w-none overflow-hidden overscroll-none rounded-t-[22px] bg-m-screen p-0 text-m-ink backdrop:bg-black/50 open:flex open:animate-[m-sheet-up_300ms_cubic-bezier(0.32,0.72,0,1)] open:flex-col"
	style:margin-bottom="var(--keyboard-inset, 0px)"
>
	{#if open}
		<div class="shrink-0 pt-2">
			<div class="mx-auto h-[5px] w-9 rounded-full bg-m-edge" aria-hidden="true"></div>
			<div class="flex min-h-12 items-center gap-2 {back ? 'pr-5 pl-1' : 'px-5'}">
				{#if back}
					<button
						type="button"
						onclick={back.onclick}
						class="flex min-h-11 min-w-11 shrink-0 items-center text-[17px] text-m-frost"
						data-testid="sheet-back"
					>
						<ChevronLeft size={26} strokeWidth={2.2} aria-hidden="true" />{back.label}
					</button>
				{/if}
				<h2
					id="{uid}-title"
					tabindex="-1"
					data-sheet-title
					class="min-w-0 flex-1 truncate text-[17px] font-semibold outline-none {back
						? 'text-center'
						: ''}"
				>
					{title}
				</h2>
				<button
					type="button"
					onclick={onClose}
					disabled={closeDisabled}
					class="min-h-11 shrink-0 px-1 text-[17px] font-semibold text-m-frost">Done</button
				>
			</div>
		</div>
		<div
			class="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-1"
			style:padding-bottom="max(16px, env(safe-area-inset-bottom))"
			data-sheet-scroll
		>
			{@render children()}
		</div>
	{/if}
</dialog>
