<script lang="ts">
	import { ChevronDown, Code, PanelsTopLeft, TerminalSquare } from 'lucide-svelte';
	import { resolve } from '$app/paths';
	import { generateId } from '$lib';

	interface Props {
		path: string;
		vscodeSshHost?: string;
		aiDisabled?: boolean;
		onOpenTerminal: (id: string, command: string, name: string, cwd: string) => void;
	}
	let { path, vscodeSshHost = '', aiDisabled = false, onOpenTerminal }: Props = $props();
	let menu: HTMLDivElement;
	let trigger: HTMLButtonElement;
	let expanded = $state(false);
	let left = $state(0);
	let top = $state(0);
	const name = $derived(path.split('/').filter(Boolean).pop() ?? path);
	const vscodeHref = $derived(
		vscodeSshHost
			? `vscode://vscode-remote/ssh-remote+${vscodeSshHost}${path}?windowId=_blank`
			: `vscode://file${path}?windowId=_blank`
	);

	/** The native popover escapes clipped rows and handles outside-click dismissal. */
	function show(event: Event, last = false) {
		event.stopPropagation();
		if (expanded) {
			close();
			return;
		}
		const box = trigger.getBoundingClientRect();
		left = Math.max(8, Math.min(box.left, window.innerWidth - 184));
		top = box.bottom + 4 + 172 > window.innerHeight ? Math.max(8, box.top - 176) : box.bottom + 4;
		menu.showPopover();
		const items = menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)');
		items[last ? items.length - 1 : 0]?.focus();
	}

	/** Dismiss before dispatch without moving focus away from a newly opened window. */
	function close() {
		menu.hidePopover();
	}

	/** Keep selection synchronous so browser popup rules allow AI service windows. */
	function openAi(tool: 'opencode' | 'openchamber') {
		close();
		const query = new URLSearchParams({ path, tool, launch: generateId() });
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
		const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
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
	onclick={show}
	onkeydown={(event) => {
		event.stopPropagation();
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			show(event, event.key === 'ArrowUp');
		}
	}}
	class="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold whitespace-nowrap text-[#4c566a] hover:bg-[#e5e9f0] dark:text-[#d8dee9] dark:hover:bg-[#434c5e]"
>
	Open with <ChevronDown size={13} />
</button>

<div
	bind:this={menu}
	popover="auto"
	role="menu"
	tabindex="-1"
	aria-label={`Open ${name} with`}
	onclick={(event) => event.stopPropagation()}
	ontoggle={() => (expanded = menu.matches(':popover-open'))}
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
</div>

<style>
	.open-menu {
		position: fixed;
		inset: auto;
		margin: 0;
		width: 176px;
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
</style>
