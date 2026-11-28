<script lang="ts">
	/** Profile node summaries. Expand a family to reach its existing per-container controls. */
	import { ChevronRight } from 'lucide-svelte';
	import type { Snippet } from 'svelte';
	import type { ContainerData } from '$lib/types';
	import type { StackView } from './types';
	import { nodeLabel, profileGroups } from './profileGroups';

	let {
		view,
		containers,
		row
	}: { view: StackView; containers: ContainerData[]; row: Snippet<[ContainerData]> } = $props();
	const groups = $derived(profileGroups(containers, view.kind));
</script>

<div
	class="divide-y divide-[#d8dee9]/60 border-t border-[#d8dee9]/60 dark:divide-[#4c566a]/60 dark:border-[#4c566a]/60"
>
	{#each groups as group (group.id)}
		<details class="group/family">
			<summary
				class="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 text-sm hover:bg-[#eceff4] dark:hover:bg-[#3b4252] [&::-webkit-details-marker]:hidden"
			>
				<span class="flex min-w-0 items-center gap-2 font-semibold [overflow-wrap:anywhere]">
					<ChevronRight size={16} class="shrink-0 group-open/family:rotate-90" />
					{group.label}
				</span>
				<span class="flex min-w-0 flex-wrap gap-2">
					{#each group.members as member (member.id)}
						<span
							class="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[#d8dee9] px-2 py-0.5 font-mono text-xs [overflow-wrap:anywhere] dark:border-[#4c566a]"
							title={`${member.name}: ${member.state}`}
						>
							<span
								class="h-2 w-2 shrink-0 rounded-full {member.state === 'running'
									? 'bg-[#a3be8c]'
									: 'bg-[#bf616a]'}"
							></span>
							<span class="sr-only">{member.state}:</span>
							{nodeLabel(member)}
						</span>
					{/each}
				</span>
			</summary>
			<div class="divide-y divide-[#d8dee9]/60 dark:divide-[#4c566a]/60">
				{#each group.members as member (member.id)}
					{@render row(member)}
				{/each}
			</div>
		</details>
	{/each}
</div>
