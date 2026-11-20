<script lang="ts">
	/**
	 * Native-popover menu shared by workspace and devcontainer rows. The popover escapes
	 * clipped rows, supports standard menu keys, and keeps events away from row handlers.
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		/** Accessible trigger name, for example "Open with: repo". */
		label: string;
		/** Accessible menu name. */
		menuLabel: string;
		title?: string;
		/** Popover size before it renders; used to keep the popover in the viewport. */
		width: number;
		height: number;
		/** Align the popover with the left or the right edge of the trigger. */
		align?: 'start' | 'end';
		disabled?: boolean;
		triggerClass: string;
		trigger: Snippet;
		/** Menu items. Call `close` before an action that opens a window or a dialog. */
		children: Snippet<[close: () => void]>;
	}
	let {
		label,
		menuLabel,
		title,
		width,
		height,
		align = 'start',
		disabled = false,
		triggerClass,
		trigger,
		children
	}: Props = $props();
	const uid = $props.id();
	const menuId = `row-menu-${uid}`;
	/** Enabled items in visual order. */
	const ITEMS = 'button:not(:disabled), a[href]';
	let menu: HTMLDivElement;
	let triggerButton: HTMLButtonElement;
	let expanded = $state(false);
	let left = $state(0);
	let top = $state(0);
	let focusLast = false;

	/** Return the enabled items in visual order. */
	function items() {
		return [...menu.querySelectorAll<HTMLElement>(ITEMS)].filter((item) => item.checkVisibility());
	}

	/** Position the popover before it opens; flip it above the trigger near the bottom edge. */
	function place() {
		const box = triggerButton.getBoundingClientRect();
		const preferred = align === 'end' ? box.right - width : box.left;
		left = Math.max(8, Math.min(preferred, window.innerWidth - width - 8));
		top =
			box.bottom + 4 + height > window.innerHeight
				? Math.max(8, box.top - height - 4)
				: box.bottom + 4;
	}

	/** Track the native state and move focus into the visible menu. */
	function toggled() {
		expanded = menu.matches(':popover-open');
		if (!expanded) return;
		const list = items();
		list[focusLast ? list.length - 1 : 0]?.focus();
		focusLast = false;
	}

	/** Arrow keys open the closed menu at its first or last item. */
	function openFromKey(event: KeyboardEvent) {
		event.stopPropagation();
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		focusLast = event.key === 'ArrowUp';
		if (!menu.matches(':popover-open')) menu.showPopover();
	}

	/** Dismiss without moving focus away from a newly opened window. */
	function close() {
		menu.hidePopover();
		// A leaf action (Open with / Services) must also dismiss its containing phone sheet.
		// Native nested popovers do not close their ancestor automatically.
		let parent = menu.parentElement?.closest<HTMLElement>('[popover]');
		while (parent) {
			if (parent.matches(':popover-open')) parent.hidePopover();
			parent = parent.parentElement?.closest<HTMLElement>('[popover]');
		}
	}

	/** Standard menu keys; stop propagation so the row does not react. */
	function navigate(event: KeyboardEvent) {
		event.stopPropagation();
		if (event.key === 'Tab') {
			close();
			return;
		}
		if (event.key === ' ' && document.activeElement instanceof HTMLAnchorElement) {
			event.preventDefault();
			document.activeElement.click();
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
			triggerButton.focus();
			return;
		}
		const list = items();
		if (!list.length) return;
		const index = list.indexOf(document.activeElement as HTMLElement);
		let next: number;
		if (event.key === 'ArrowDown') next = (index + 1) % list.length;
		else if (event.key === 'ArrowUp') next = (index - 1 + list.length) % list.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = list.length - 1;
		else return;
		event.preventDefault();
		list[next]?.focus();
	}
</script>

<button
	bind:this={triggerButton}
	type="button"
	aria-label={label}
	aria-haspopup="menu"
	aria-expanded={expanded}
	{title}
	{disabled}
	popovertarget={menuId}
	onclick={(event) => event.stopPropagation()}
	onkeydown={openFromKey}
	class={triggerClass}
>
	{@render trigger()}
</button>

<div
	bind:this={menu}
	id={menuId}
	popover="auto"
	role="menu"
	tabindex="-1"
	aria-label={menuLabel}
	onclick={(event) => event.stopPropagation()}
	onbeforetoggle={place}
	ontoggle={toggled}
	onkeydown={navigate}
	style:left={`${left}px`}
	style:top={`${top}px`}
	style:width={`${width}px`}
	class="row-menu rounded-lg border border-[#d8dee9] bg-white p-1 text-[#2e3440] shadow-lg dark:border-[#4c566a] dark:bg-[#3b4252] dark:text-[#eceff4]"
>
	{@render children(close)}
	<button
		type="button"
		role="menuitem"
		onclick={close}
		class="mt-2 min-h-11 justify-center rounded-lg border border-[#4c566a]/40 font-semibold md:hidden"
		>Close menu</button
	>
</div>

<style>
	.row-menu {
		position: fixed;
		inset: auto;
		margin: 0;
	}
	.row-menu:popover-open {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	/* Items come from the caller's snippet, so these selectors are global inside the menu. */
	.row-menu :global([role='menuitem']) {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		border-radius: 5px;
		padding: 0.5rem;
		font-size: 0.75rem;
		text-align: left;
		text-decoration: none;
		color: inherit;
		cursor: pointer;
	}
	.row-menu :global([role='menuitem']:focus-visible) {
		outline: 2px solid #81a1c1;
		outline-offset: -2px;
	}
	.row-menu :global([role='menuitem']:hover) {
		background: #81a1c126;
	}
	.row-menu :global([role='menuitem']:disabled) {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.row-menu :global(.menu-text) {
		flex: 1;
	}
	.row-menu :global(.menu-hint) {
		margin-left: auto;
		font-size: 0.6875rem;
		opacity: 0.6;
		white-space: nowrap;
	}
	.row-menu :global(.menu-caption) {
		padding: 0.25rem 0.5rem 0.125rem;
		font-size: 0.6875rem;
		opacity: 0.6;
	}
	.row-menu :global(.menu-divider) {
		height: 1px;
		margin: 3px 2px;
		background: #d8dee9;
	}
	:global(.dark) .row-menu :global(.menu-divider) {
		background: #4c566a;
	}
	.row-menu :global(.menu-danger) {
		color: #bf616a;
	}
</style>
