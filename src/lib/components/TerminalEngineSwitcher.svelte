<script lang="ts">
	/**
	 * Terminal engine switcher for the active shell tab (#42). The button shows the
	 * engine in use. Its menu replaces the tab's viewer in place; the process keeps running.
	 */
	import { Check, ChevronDown } from 'lucide-svelte';
	import {
		TERMINAL_ENGINE_IDS,
		TERMINAL_ENGINES,
		type TerminalEngineId,
		type TerminalViewIdentity
	} from '$lib/terminalView';

	interface Props {
		/** Engine selected for the active shell tab. */
		value: TerminalEngineId;
		/** What the viewer actually initialized. Undefined while it starts or after it fails. */
		identity?: TerminalViewIdentity;
		onSelect: (engine: TerminalEngineId) => void;
	}
	let { value, identity, onSelect }: Props = $props();
	const uid = $props.id();
	const menuId = `terminal-engine-${uid}`;
	const ITEMS = '[role="menuitemradio"]';
	/** Menu width before it renders, used to keep it inside the viewport. */
	const MENU_WIDTH = 240;
	let menu: HTMLDivElement;
	let trigger: HTMLButtonElement;
	let expanded = $state(false);
	let left = $state(8);
	let bottom = $state(48);

	/** Open the menu above the trigger: the drawer sits at the bottom of the page. */
	function place() {
		const box = trigger.getBoundingClientRect();
		left = Math.max(8, Math.min(box.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
		bottom = Math.max(8, window.innerHeight - box.top + 4);
	}

	/** Track the native popover state and move focus to the selected engine. */
	function toggled() {
		expanded = menu.matches(':popover-open');
		if (!expanded) return;
		menu.querySelector<HTMLElement>(`${ITEMS}[aria-checked="true"]`)?.focus();
	}

	/** Close the menu, then switch only when the engine changes. */
	function choose(engine: TerminalEngineId) {
		menu.hidePopover();
		if (engine !== value) onSelect(engine);
	}

	/** Menu keyboard navigation. Escape returns focus to the trigger; outside clicks dismiss natively. */
	function navigate(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			menu.hidePopover();
			trigger.focus();
			return;
		}
		if (event.key === 'Tab') {
			menu.hidePopover();
			return;
		}
		const items = [...menu.querySelectorAll<HTMLElement>(ITEMS)];
		const index = items.indexOf(document.activeElement as HTMLElement);
		let next: number | undefined;
		if (event.key === 'ArrowDown') next = (index + 1) % items.length;
		else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = items.length - 1;
		if (next === undefined) return;
		event.preventDefault();
		items[next]?.focus();
	}
</script>

<button
	bind:this={trigger}
	type="button"
	popovertarget={menuId}
	aria-haspopup="menu"
	aria-expanded={expanded}
	aria-controls={menuId}
	onclick={place}
	title={identity
		? `${identity.core} · ${identity.renderer}${identity.fallback ? ` — ${identity.fallback}` : ''}`
		: 'Terminal engine'}
	data-terminal-engine-switcher
	class="flex shrink-0 items-center gap-1.5 rounded-md border border-[#4c566a] px-2 py-0.5 text-[11px] font-medium text-[#d8dee9]/80 transition-colors hover:bg-[#3b4252] hover:text-[#eceff4]"
>
	<span class="sr-only">Terminal engine:</span>
	{#if identity?.fallback}
		<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-[#ebcb8b]" aria-hidden="true"></span>
		<span class="sr-only">(fallback renderer)</span>
	{/if}
	{TERMINAL_ENGINES[value].label}
	<ChevronDown size={12} class="opacity-60" />
</button>

<div
	bind:this={menu}
	id={menuId}
	popover="auto"
	role="menu"
	tabindex="-1"
	aria-label="Terminal engine"
	ontoggle={toggled}
	onkeydown={navigate}
	style:left={`${left}px`}
	style:bottom={`${bottom}px`}
	class="engine-menu rounded-lg border border-[#4c566a] bg-[#3b4252] p-1 text-[#eceff4] shadow-lg"
>
	<p class="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-[#d8dee9]/60 uppercase">
		Terminal engine
	</p>
	{#each TERMINAL_ENGINE_IDS as engine (engine)}
		<button
			role="menuitemradio"
			tabindex="-1"
			type="button"
			aria-checked={engine === value}
			aria-labelledby={`${menuId}-${engine}`}
			aria-describedby={`${menuId}-${engine}-hint`}
			onclick={() => choose(engine)}
			class="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-[#434c5e] focus:bg-[#434c5e] focus:outline-none"
		>
			<span class="mt-0.5 flex w-3.5 shrink-0 justify-center text-[#88c0d0]" aria-hidden="true"
				>{#if engine === value}<Check size={13} />{/if}</span
			>
			<span class="min-w-0">
				<span id={`${menuId}-${engine}`} class="block text-xs font-medium"
					>{TERMINAL_ENGINES[engine].label}</span
				>
				<span id={`${menuId}-${engine}-hint`} class="block text-[11px] text-[#d8dee9]/60"
					>{TERMINAL_ENGINES[engine].hint}</span
				>
			</span>
		</button>
	{/each}
	{#if identity}
		<p class="mx-1 mt-1 border-t border-[#4c566a] px-1.5 pt-1.5 pb-1 text-[11px]">
			<span class="text-[#d8dee9]/60">Running</span>
			<span class="text-[#eceff4]">{identity.core} · {identity.renderer}</span>
			{#if identity.fallback}<span class="mt-0.5 block text-[#ebcb8b]">{identity.fallback}</span
				>{/if}
		</p>
	{/if}
</div>

<style>
	.engine-menu {
		position: fixed;
		inset: auto;
		margin: 0;
		width: 240px;
	}
	.engine-menu:popover-open {
		display: flex;
		flex-direction: column;
	}
</style>
