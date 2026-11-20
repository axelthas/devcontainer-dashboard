<script lang="ts">
	/** The four sections. Each tab keeps its own place: the link goes to the tab root. */
	import { Box, Cpu, FolderGit2, SquareTerminal } from 'lucide-svelte';
	import { resolve } from '$app/paths';

	interface Props {
		/** The section of the current route */
		current: 'containers' | 'workspaces' | 'services' | 'terminals' | null;
		terminalCount: number;
	}
	let { current, terminalCount }: Props = $props();
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
		}
	] as const;
</script>

<nav
	aria-label="Sections"
	class="fixed inset-x-0 bottom-0 z-30 border-t border-m-edge/70 bg-m-screen/92 backdrop-blur-xl"
	style:padding-bottom="env(safe-area-inset-bottom)"
>
	<div class="grid h-[52px] grid-cols-4 px-1">
		{#each TABS as tab (tab.id)}
			<a
				href={resolve(tab.path)}
				aria-current={current === tab.id ? 'page' : undefined}
				class="relative flex flex-col items-center justify-center gap-0.5 {current === tab.id
					? 'text-m-frost'
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
			</a>
		{/each}
	</div>
</nav>
