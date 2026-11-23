<script lang="ts">
	/**
	 * The sections. Each tab keeps its own place: the link goes to the tab root. The Brain tab
	 * shows only while the Brain endpoint runs.
	 */
	import { BrainCircuit, Box, Cpu, FolderGit2, SquareTerminal } from 'lucide-svelte';
	import { resolve } from '$app/paths';

	interface Props {
		/** The section of the current route */
		current: 'containers' | 'workspaces' | 'services' | 'terminals' | 'brain' | null;
		terminalCount: number;
		/** True while the Brain endpoint runs */
		brainEnabled?: boolean;
		/** True while Brain runs a command */
		brainRunning?: boolean;
	}
	let { current, terminalCount, brainEnabled = false, brainRunning = false }: Props = $props();
	const TABS = [
		{ id: 'containers', label: 'Containers', icon: Box, path: '/mobile/containers' },
		{
			id: 'workspaces',
			label: 'Workspaces',
			icon: FolderGit2,
			path: '/mobile/workspaces'
		},
		{ id: 'services', label: 'Services', icon: Cpu, path: '/mobile/services' },
		{
			id: 'terminals',
			label: 'Terminals',
			icon: SquareTerminal,
			path: '/mobile/terminals'
		},
		{ id: 'brain', label: 'Brain', icon: BrainCircuit, path: '/mobile/brain' }
	] as const;
	const tabs = $derived(TABS.filter((tab) => tab.id !== 'brain' || brainEnabled));
</script>

<nav
	aria-label="Sections"
	class="fixed inset-x-0 bottom-0 z-30 border-t border-m-edge/70 bg-m-screen/92 backdrop-blur-xl"
	style:padding-bottom="env(safe-area-inset-bottom)"
>
	<div class="grid h-[52px] px-1 {tabs.length === 5 ? 'grid-cols-5' : 'grid-cols-4'}">
		{#each tabs as tab (tab.id)}
			<a
				href={resolve(tab.path)}
				aria-current={current === tab.id ? 'page' : undefined}
				class="relative flex flex-col items-center justify-center gap-0.5 {current === tab.id
					? tab.id === 'brain'
						? 'text-m-brain'
						: 'text-m-frost'
					: 'text-m-dim'}"
			>
				<tab.icon size={24} strokeWidth={current === tab.id ? 2.3 : 1.8} aria-hidden="true" />
				<span class="text-[11px] font-medium">{tab.label}</span>
				{#if tab.id === 'terminals' && terminalCount > 0}
					<span
						class="absolute top-0.5 left-[55%] min-w-[18px] rounded-full bg-m-stop px-1 text-center text-[12px] leading-[18px] font-semibold text-white"
						aria-label={`${terminalCount} sessions`}>{terminalCount}</span
					>
				{/if}
				{#if tab.id === 'brain' && brainRunning}
					<span
						class="absolute top-1 left-[58%] size-2.5 animate-pulse rounded-full bg-m-warn"
						aria-label="Brain is running a command"
					></span>
				{/if}
			</a>
		{/each}
	</div>
</nav>
