<script lang="ts">
	import { Check, ChevronDown, Code, PanelsTopLeft, TerminalSquare } from 'lucide-svelte';
	import { resolve } from '$app/paths';
	import { generateId } from '$lib';
	import { TERMINAL_ENGINE_IDS, TERMINAL_ENGINES } from '$lib/terminalView';
	import {
		defaultTerminalEngine,
		setDefaultTerminalEngine
	} from '$lib/terminalEnginePreference.svelte';

	interface Props {
		path: string;
		vscodeSshHost?: string;
		aiDisabled?: boolean;
		onOpenTerminal: (id: string, command: string, name: string, cwd: string) => void;
	}
	let { path, vscodeSshHost = '', aiDisabled = false, onOpenTerminal }: Props = $props();
	const uid = $props.id();
	const menuId = `open-with-${uid}`;
	/** Actions and engine choices in visual order; both use menu keyboard navigation. */
	const ITEMS = '[role^="menuitem"]:not(:disabled)';
	/** Popover size before it renders: four actions plus the terminal engine choices. */
	const MENU_WIDTH = 208;
	const MENU_HEIGHT = 324;
	let menu: HTMLDivElement;
	let trigger: HTMLButtonElement;
	let expanded = $state(false);
	let left = $state(0);
	let top = $state(0);
	let focusLast = false;
	const name = $derived(path.split('/').filter(Boolean).pop() ?? path);
	const vscodeHref = $derived(
		vscodeSshHost
			? `vscode://vscode-remote/ssh-remote+${vscodeSshHost}${path}?windowId=_blank`
			: `vscode://file${path}?windowId=_blank`
	);

	/** Position the native popover before it opens; it escapes clipped rows. */
	function place() {
		const box = trigger.getBoundingClientRect();
		left = Math.max(8, Math.min(box.left, window.innerWidth - MENU_WIDTH - 8));
		top =
			box.bottom + 4 + MENU_HEIGHT > window.innerHeight
				? Math.max(8, box.top - MENU_HEIGHT - 4)
				: box.bottom + 4;
	}

	/** Track the native state and move focus into the visible menu. */
	function toggled() {
		expanded = menu.matches(':popover-open');
		if (!expanded) return;
		const items = menu.querySelectorAll<HTMLElement>(ITEMS);
		items[focusLast ? items.length - 1 : 0]?.focus();
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

	/** Dismiss before dispatch without moving focus away from a newly opened window. */
	function close() {
		menu.hidePopover();
	}

	/** Keep selection synchronous so browser popup rules allow AI service windows. */
	function openAi(tool: 'opencode' | 'openchamber') {
		close();
		const query = new URLSearchParams({ path, tool, launch: generateId() });
		// The OpenCode TUI window renders its terminal with the selected engine.
		if (tool === 'opencode') query.set('engine', defaultTerminalEngine());
		window.open(resolve(`/ai?${query}`), '_blank', 'noopener,noreferrer');
	}

	/** Use the same terminal drawer callback as the former terminal icon. */
	function openTerminal() {
		close();
		onOpenTerminal(generateId(), '', name, path);
	}

	/** Support standard menu navigation without triggering workspace-row shortcuts. */
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
			trigger.focus();
			return;
		}
		const items = [...menu.querySelectorAll<HTMLElement>(ITEMS)];
		const index = items.indexOf(document.activeElement as HTMLElement);
		let next: number;
		if (event.key === 'ArrowDown') next = (index + 1) % items.length;
		else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = items.length - 1;
		else return;
		event.preventDefault();
		items[next]?.focus();
	}
</script>

<button
	bind:this={trigger}
	type="button"
	aria-label={`Open with: ${name}`}
	aria-haspopup="menu"
	aria-expanded={expanded}
	title={`Open ${path} with…`}
	popovertarget={menuId}
	onclick={(event) => event.stopPropagation()}
	onkeydown={openFromKey}
	class="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold whitespace-nowrap text-[#4c566a] hover:bg-[#e5e9f0] dark:text-[#d8dee9] dark:hover:bg-[#434c5e]"
>
	Open with <ChevronDown size={13} />
</button>

<div
	bind:this={menu}
	id={menuId}
	popover="auto"
	role="menu"
	tabindex="-1"
	aria-label={`Open ${name} with`}
	onclick={(event) => event.stopPropagation()}
	onbeforetoggle={place}
	ontoggle={toggled}
	onkeydown={navigate}
	style:left={`${left}px`}
	style:top={`${top}px`}
	class="open-menu rounded-lg border border-[#d8dee9] bg-white p-1 text-[#2e3440] shadow-lg dark:border-[#4c566a] dark:bg-[#3b4252] dark:text-[#eceff4]"
>
	<a role="menuitem" tabindex="-1" href={vscodeHref} rel="external" onclick={close}>
		<Code size={15} />VS Code
	</a>
	<button role="menuitem" tabindex="-1" type="button" onclick={openTerminal}>
		<TerminalSquare size={15} />Terminal
	</button>
	<button
		role="menuitem"
		tabindex="-1"
		type="button"
		disabled={aiDisabled}
		onclick={() => openAi('opencode')}
	>
		<TerminalSquare size={15} />OpenCode TUI
	</button>
	<button
		role="menuitem"
		tabindex="-1"
		type="button"
		disabled={aiDisabled}
		onclick={() => openAi('openchamber')}
	>
		<PanelsTopLeft size={15} />OpenChamber
	</button>
	<div role="separator" class="menu-separator"></div>
	<div role="group" aria-labelledby={`${menuId}-engine`} class="menu-group">
		<span id={`${menuId}-engine`} class="menu-label">Terminal engine</span>
		{#each TERMINAL_ENGINE_IDS as engine (engine)}
			<button
				role="menuitemradio"
				tabindex="-1"
				type="button"
				aria-checked={defaultTerminalEngine() === engine}
				title={TERMINAL_ENGINES[engine].description}
				onclick={() => setDefaultTerminalEngine(engine)}
			>
				<span class="menu-check" aria-hidden="true"
					>{#if defaultTerminalEngine() === engine}<Check size={13} />{/if}</span
				>{TERMINAL_ENGINES[engine].label}
			</button>
		{/each}
	</div>
</div>

<style>
	.open-menu {
		position: fixed;
		inset: auto;
		margin: 0;
		width: 208px;
	}
	.open-menu:popover-open {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.open-menu :is(a, button) {
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
	.open-menu :is(a, button):focus-visible {
		outline: 2px solid #81a1c1;
		outline-offset: -2px;
	}
	.open-menu :is(a, button):hover {
		background: #81a1c126;
	}
	.open-menu button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.menu-separator {
		height: 1px;
		margin: 0.25rem 0;
		background: #81a1c140;
	}
	.menu-group {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.menu-label {
		padding: 0.25rem 0.5rem 0.125rem;
		font-size: 0.65rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		opacity: 0.7;
	}
	.menu-check {
		display: inline-flex;
		justify-content: center;
		width: 15px;
	}
</style>
