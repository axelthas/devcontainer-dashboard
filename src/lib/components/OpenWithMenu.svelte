<script lang="ts">
	import { ChevronDown, Code, PanelsTopLeft, TerminalSquare } from 'lucide-svelte';
	import { resolve } from '$app/paths';
	import { generateId } from '$lib';
	import type { ContainerData } from '$lib/types';
	import { buildContainerVscodeUri } from '$lib/vscode';
	import {
		containerOpenCodeBlocker,
		containerOpenCodeCommand,
		containerShellBlocker,
		containerShellCommand
	} from '$lib/containerOpenTargets';
	import { openContainerService } from '$lib/serviceLaunch';
	import RowMenu from './RowMenu.svelte';

	interface Props {
		/** Host folder. For a devcontainer: its local workspace folder, or '' when unknown. */
		path: string;
		vscodeSshHost?: string;
		aiDisabled?: boolean;
		/**
		 * Devcontainer target. Running: every action opens inside the container.
		 * Stopped: actions open `path` on the host, and the menu says so.
		 */
		container?: ContainerData;
		serviceProxyEnabled?: boolean;
		disabled?: boolean;
		onOpenTerminal: (id: string, command: string, name: string, cwd: string) => void;
	}
	let {
		path,
		vscodeSshHost = '',
		aiDisabled = false,
		container,
		serviceProxyEnabled,
		disabled = false,
		onOpenTerminal
	}: Props = $props();

	/** Container port that OpenChamber publishes. */
	const OPENCHAMBER_PORT = '3000';

	const inContainer = $derived(container?.state === 'running');
	const name = $derived(container?.projectName ?? path.split('/').filter(Boolean).pop() ?? path);
	const caption = $derived(
		!container ? '' : inContainer ? 'Inside the container' : 'Container stopped: host folder'
	);
	/** A stopped container without a known host folder has nothing to open. */
	const unavailable = $derived(disabled || (Boolean(container) && !inContainer && !path));
	const hostVscodeHref = $derived(
		vscodeSshHost
			? `vscode://vscode-remote/ssh-remote+${vscodeSshHost}${path}?windowId=_blank`
			: `vscode://file${path}?windowId=_blank`
	);
	const vscodeHref = $derived(
		container && inContainer ? buildContainerVscodeUri(container, vscodeSshHost) : hostVscodeHref
	);
	// Container commands run as the remote user. A blocker disables the item and gives the reason.
	const target = $derived(container && inContainer ? container : undefined);
	const shellCommand = $derived(target ? containerShellCommand(target) : null);
	const shellBlocker = $derived(target ? containerShellBlocker(target) : null);
	const openCodeCommand = $derived(target ? containerOpenCodeCommand(target) : null);
	const openCodeBlocker = $derived(target ? containerOpenCodeBlocker(target) : null);
	const servesOpenChamber = $derived(Boolean(container?.ports[OPENCHAMBER_PORT]));
	const tuiDisabled = $derived(inContainer ? !openCodeCommand : aiDisabled);
	const chamberDisabled = $derived(inContainer ? !servesOpenChamber : aiDisabled);
	const where = $derived(inContainer ? 'in container' : 'host');
	const terminalHint = $derived(commandHint(shellBlocker));
	const tuiHint = $derived(commandHint(openCodeBlocker));

	/** Short menu hint for a container command: the blocker, the user, or the location. */
	function commandHint(blocker: string | null): string {
		if (!target) return where;
		if (target.remoteUserError) return 'user invalid';
		if (blocker) return 'folder unknown';
		return target.remoteUser ? `as ${target.remoteUser}` : where;
	}

	/** Keep selection synchronous so browser popup rules allow AI service windows. */
	function openAi(close: () => void, tool: 'opencode' | 'openchamber') {
		close();
		const query = new URLSearchParams({ path, tool, launch: generateId() });
		window.open(resolve(`/ai?${query}`), '_blank', 'noopener,noreferrer');
	}

	/** Open a shell in the terminal drawer: in the container, or in the host folder. */
	function openTerminal(close: () => void) {
		if (container && inContainer) {
			if (!shellCommand) return;
			close();
			onOpenTerminal(generateId(), shellCommand, name, container.localWorkspacePath ?? '');
			return;
		}
		close();
		onOpenTerminal(generateId(), '', name, path);
	}

	/** Run the OpenCode TUI in the terminal drawer inside the container's workspace folder. */
	function openTui(close: () => void) {
		if (!container || !inContainer) {
			openAi(close, 'opencode');
			return;
		}
		if (!openCodeCommand) return;
		close();
		onOpenTerminal(
			generateId(),
			openCodeCommand,
			`${name} · OpenCode`,
			container.localWorkspacePath ?? ''
		);
	}

	/** Open the container's OpenChamber service, or OpenChamber for the host folder. */
	function openChamber(close: () => void) {
		if (!container || !inContainer) {
			openAi(close, 'openchamber');
			return;
		}
		if (!servesOpenChamber) return;
		close();
		openContainerService({
			containerPort: OPENCHAMBER_PORT,
			hostPort: container.ports[OPENCHAMBER_PORT],
			label: 'OpenChamber',
			containerName: container.name,
			projectName: container.projectName,
			workspacePath: container.localWorkspacePath,
			allPorts: container.ports,
			containerId: container.id,
			serviceProxyEnabled
		});
	}
</script>

<RowMenu
	label={`Open with: ${name}`}
	menuLabel={`Open ${name} with`}
	title={`Open ${container ? name : path} with…`}
	width={container ? 248 : 176}
	height={caption ? 204 : 172}
	disabled={unavailable}
	triggerClass="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold whitespace-nowrap text-[#4c566a] hover:bg-[#e5e9f0] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#d8dee9] dark:hover:bg-[#434c5e]"
>
	{#snippet trigger()}
		Open with <ChevronDown size={13} />
	{/snippet}
	{#snippet children(close: () => void)}
		{#if caption}
			<span class="menu-caption">{caption}</span>
		{/if}
		<a role="menuitem" tabindex="-1" href={vscodeHref} rel="external" onclick={close}>
			<Code size={15} /><span class="menu-text">VS Code</span>
			{#if container}<span class="menu-hint" aria-hidden="true">{where}</span>{/if}
		</a>
		<button
			role="menuitem"
			tabindex="-1"
			type="button"
			disabled={Boolean(shellBlocker)}
			title={shellBlocker ?? shellCommand ?? undefined}
			onclick={() => openTerminal(close)}
		>
			<TerminalSquare size={15} /><span class="menu-text">Terminal</span>
			{#if container}<span class="menu-hint" aria-hidden="true">{terminalHint}</span>{/if}
		</button>
		<button
			role="menuitem"
			tabindex="-1"
			type="button"
			disabled={tuiDisabled}
			title={openCodeBlocker ?? openCodeCommand ?? undefined}
			onclick={() => openTui(close)}
		>
			<TerminalSquare size={15} class="text-[#b48ead]" /><span class="menu-text">OpenCode TUI</span>
			{#if container}<span class="menu-hint" aria-hidden="true">{tuiHint}</span>{/if}
		</button>
		<button
			role="menuitem"
			tabindex="-1"
			type="button"
			disabled={chamberDisabled}
			title={inContainer && !servesOpenChamber
				? 'Unavailable: this container does not publish OpenChamber'
				: undefined}
			onclick={() => openChamber(close)}
		>
			<PanelsTopLeft size={15} class="text-[#8fbcbb]" /><span class="menu-text">OpenChamber</span>
			{#if container}<span class="menu-hint" aria-hidden="true"
					>{inContainer ? (servesOpenChamber ? `:${OPENCHAMBER_PORT}` : 'not served') : where}</span
				>{/if}
		</button>
	{/snippet}
</RowMenu>
