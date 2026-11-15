<script lang="ts">
	import { Ellipsis, Loader2, RotateCcw, Trash2 } from 'lucide-svelte';

	interface Props {
		name: string;
		canRerun: boolean;
		rerunning?: boolean;
		deleting?: boolean;
		onRerun: () => void;
		onDelete: () => void;
	}
	let { name, canRerun, rerunning = false, deleting = false, onRerun, onDelete }: Props = $props();
	const uid = $props.id();
	const menuId = `workspace-more-${uid}`;
	let menu: HTMLDivElement;
	let trigger: HTMLButtonElement;
	let expanded = $state(false);
	let left = $state(0);
	let top = $state(0);
	let focusLast = false;

	/** Return the enabled items in visual order. */
	function items() {
		return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
	}

	/** Right-align the popover to the trigger before it opens; flip above near the bottom. */
	function place() {
		const box = trigger.getBoundingClientRect();
		const height = canRerun ? 100 : 52;
		left = Math.max(8, Math.min(box.right - 208, window.innerWidth - 216));
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

	/** Dismiss without moving focus; Escape restores it to the trigger explicitly. */
	function close() {
		menu.hidePopover();
	}

	/** Close before the action, so a confirmation dialog never sits behind the menu. */
	function run(action: () => void) {
		close();
		action();
	}

	/** Standard menu keys; stop propagation so the workspace row does not toggle. */
	function navigate(event: KeyboardEvent) {
		event.stopPropagation();
		if (event.key === 'Tab') {
			close();
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
			trigger.focus();
			return;
		}
		const list = items();
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
	bind:this={trigger}
	type="button"
	aria-label={`More actions: ${name}`}
	aria-haspopup="menu"
	aria-expanded={expanded}
	title="More actions"
	popovertarget={menuId}
	onclick={(event) => event.stopPropagation()}
	onkeydown={openFromKey}
	class="flex h-7 w-7 items-center justify-center rounded-lg text-[#4c566a] hover:bg-[#e5e9f0] aria-expanded:bg-[#e5e9f0] dark:text-[#d8dee9] dark:hover:bg-[#434c5e] dark:aria-expanded:bg-[#434c5e]"
>
	{#if deleting}
		<Loader2 size={15} class="animate-spin" />
	{:else}
		<Ellipsis size={16} />
	{/if}
</button>

<div
	bind:this={menu}
	id={menuId}
	popover="auto"
	role="menu"
	tabindex="-1"
	aria-label={`More actions for ${name}`}
	onclick={(event) => event.stopPropagation()}
	onbeforetoggle={place}
	ontoggle={toggled}
	onkeydown={navigate}
	style:left={`${left}px`}
	style:top={`${top}px`}
	class="more-menu rounded-lg border border-[#d8dee9] bg-white p-1 text-[#2e3440] shadow-lg dark:border-[#4c566a] dark:bg-[#3b4252] dark:text-[#eceff4]"
>
	{#if canRerun}
		<button
			role="menuitem"
			tabindex="-1"
			type="button"
			disabled={rerunning}
			onclick={() => run(onRerun)}
			class="rerun"
		>
			{#if rerunning}
				<Loader2 size={14} class="animate-spin" />Bootstrap running…
			{:else}
				<RotateCcw size={14} />Rerun bootstrap
			{/if}
		</button>
		<div class="divider" role="separator"></div>
	{/if}
	<button
		role="menuitem"
		tabindex="-1"
		type="button"
		disabled={deleting}
		onclick={() => run(onDelete)}
		class="delete"
	>
		<Trash2 size={14} />Delete workspace…
	</button>
</div>

<style>
	.more-menu {
		position: fixed;
		inset: auto;
		margin: 0;
		width: 208px;
	}
	.more-menu:popover-open {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.more-menu button {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		border-radius: 5px;
		padding: 0.5rem;
		font-size: 0.75rem;
		text-align: left;
		cursor: pointer;
	}
	.more-menu button:focus-visible {
		outline: 2px solid #81a1c1;
		outline-offset: -2px;
	}
	.more-menu button:hover {
		background: #81a1c126;
	}
	.more-menu button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.rerun {
		color: #b48ead;
	}
	.delete {
		color: #bf616a;
	}
	.divider {
		height: 1px;
		margin: 3px 2px;
		background: #d8dee9;
	}
	:global(.dark) .divider {
		background: #4c566a;
	}
</style>
