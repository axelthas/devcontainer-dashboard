<script lang="ts">
	import { ChevronDown, Code, TerminalSquare } from 'lucide-svelte';
	import type { ContainerData } from '$lib/types';
	import { buildContainerVscodeUri } from '$lib/vscode';
	import RowMenu from './RowMenu.svelte';

	interface Props {
		container: ContainerData;
		vscodeSshHost?: string;
		disabled?: boolean;
		/** Open a shell in the terminal drawer; without it, Terminal is disabled. */
		onOpenTerminal?: () => void;
	}
	let { container, vscodeSshHost = '', disabled = false, onOpenTerminal }: Props = $props();

	const running = $derived(container.state === 'running');
	const vscodeHref = $derived(buildContainerVscodeUri(container, vscodeSshHost));
</script>

<RowMenu
	label={`Open with: ${container.projectName}`}
	menuLabel={`Open ${container.projectName} with`}
	title={running ? `Open ${container.projectName} with…` : 'Start the container first'}
	width={216}
	height={112}
	disabled={disabled || !running}
	triggerClass="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold whitespace-nowrap text-[#4c566a] hover:bg-[#e5e9f0] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#434c5e]"
>
	{#snippet trigger()}
		Open with <ChevronDown size={13} />
	{/snippet}
	{#snippet children(close: () => void)}
		<span class="menu-caption">Inside the container</span>
		<a role="menuitem" tabindex="-1" href={vscodeHref} rel="external" onclick={close}>
			<Code size={15} /><span class="menu-text">VS Code</span>
			<span class="menu-hint" aria-hidden="true">attach</span>
		</a>
		<button
			role="menuitem"
			tabindex="-1"
			type="button"
			disabled={!onOpenTerminal}
			onclick={() => {
				close();
				onOpenTerminal?.();
			}}
		>
			<TerminalSquare size={15} /><span class="menu-text">Terminal</span>
		</button>
	{/snippet}
</RowMenu>
