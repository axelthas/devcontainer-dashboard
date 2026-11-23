<script lang="ts">
	/**
	 * Brain's work, grouped by granted container. Each group shows the grant and its time
	 * left, then the commands that Brain ran there, led by their goals. Calls that started no
	 * command show in their container, or under "Refused outside granted containers".
	 * The desktop Brain pane and the mobile Brain tab both use this view.
	 */
	import type { Attachment } from 'svelte/attachments';
	import { SvelteSet } from 'svelte/reactivity';
	import { ChevronDown, ShieldAlert, SquareTerminal, TriangleAlert } from 'lucide-svelte';
	import { buildActivity, isRunningStep, type BrainActivityGroup } from '$lib/brainActivity';
	import { formatRemaining, type BrainAccess } from '$lib/brainAccess.svelte';
	import { errorMessage } from '$lib/requests';
	import BrainCommandStep from './BrainCommandStep.svelte';

	type Filter = 'all' | 'running' | 'problems';
	interface Props {
		access: BrainAccess;
		/** Show the terminal for one execution */
		onOpenTerminal: (executionId: string) => void;
		/** Pointer over a group, for highlighting its container row; null when it leaves */
		onHoverGrant?: (containerId: string | null) => void;
		compact?: boolean;
	}

	let { access, onOpenTerminal, onHoverGrant, compact = false }: Props = $props();

	const activity = $derived(buildActivity(access.status));
	let filter = $state<Filter>('all');
	let working = $state('');
	let failure = $state('');
	const collapsed = new SvelteSet<string>();
	/** The group that a container row asked for shows expanded and passes every filter. */
	const focused = $derived(access.focusRequest?.grantId ?? null);

	const visible = $derived(
		activity.groups.filter((group) => {
			if (group.grantId === focused) return true;
			if (filter === 'running') return group.running > 0;
			if (filter === 'problems') return hasProblems(group);
			return true;
		})
	);

	function hasProblems(group: BrainActivityGroup): boolean {
		return (
			group.refused.length > 0 ||
			group.steps.some(
				(step) =>
					(step.status === 'exited' && step.exitCode !== 0) ||
					step.status === 'failed' ||
					step.trail.some((entry) => entry.outcome !== 'ok')
			)
		);
	}

	function stepsShown(group: BrainActivityGroup) {
		if (filter === 'running') return group.steps.filter(isRunningStep);
		return group.steps;
	}

	// Scroll to the group that the operator asked for, and land on its running command.
	/**
	 * Scroll to a group when a container row asks for it, and land on its running command.
	 * The request clears after two seconds, so later status polls do not move the view.
	 */
	function scrollWhenFocused(grantId: string): Attachment<HTMLElement> {
		return (node) => {
			if (access.focusRequest?.grantId !== grantId) return;
			const frame = requestAnimationFrame(() => {
				const target = node.querySelector<HTMLElement>('[data-running]') ?? node;
				target.scrollIntoView({ behavior: 'smooth', block: 'start' });
			});
			return () => cancelAnimationFrame(frame);
		};
	}

	/** Run one operator action at a time and show its failure above the groups. */
	async function act(key: string, action: () => Promise<void>) {
		if (working) return;
		working = key;
		failure = '';
		try {
			await action();
		} catch (cause) {
			failure = errorMessage(cause);
		} finally {
			working = '';
		}
	}

	function toggle(grantId: string) {
		if (collapsed.has(grantId)) collapsed.delete(grantId);
		else collapsed.add(grantId);
	}

	function timeOf(at: string): string {
		return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	/** Share of the grant time that is left, for the bar in the group header. */
	function remainingShare(group: BrainActivityGroup): number {
		const grant = group.grant;
		if (!grant) return 0;
		const total = Date.parse(grant.expiresAt) - Date.parse(grant.createdAt);
		const left = Date.parse(grant.expiresAt) - access.now;
		return total > 0 ? Math.min(1, Math.max(0, left / total)) : 0;
	}

	const FILTERS: [Filter, string][] = [
		['all', 'All'],
		['running', 'Running'],
		['problems', 'Problems']
	];
</script>

<div class="grid content-start gap-4">
	<div class="flex flex-wrap items-center gap-1" role="group" aria-label="Show commands">
		{#each FILTERS as [id, label] (id)}
			<button
				type="button"
				aria-pressed={filter === id}
				onclick={() => (filter = id)}
				class="rounded-full px-3 py-1 text-xs font-medium transition-colors {filter === id
					? 'bg-white text-[#2e3440] shadow-sm dark:bg-[#434c5e] dark:text-[#eceff4]'
					: 'text-[#4c566a] hover:text-[#2e3440] dark:text-[#d8dee9]/60 dark:hover:text-[#eceff4]'}"
			>
				{label}
			</button>
		{/each}
	</div>

	{#if failure}
		<p role="alert" class="text-xs text-[#bf616a]">{failure}</p>
	{/if}

	{#if activity.groups.length === 0}
		<p class="py-6 text-center text-sm text-[#4c566a] dark:text-[#d8dee9]/70">
			No containers are granted. Use Grant Brain on a running container.
		</p>
	{:else if visible.length === 0}
		<p class="py-6 text-center text-sm text-[#4c566a] dark:text-[#d8dee9]/70">
			Nothing matches this filter.
		</p>
	{/if}

	{#each visible as group (group.grantId)}
		{@const open = !collapsed.has(group.grantId) || group.grantId === focused}
		<section
			{@attach scrollWhenFocused(group.grantId)}
			onpointerenter={() => onHoverGrant?.(group.grant?.containerId ?? null)}
			onpointerleave={() => onHoverGrant?.(null)}
			aria-label={`Brain in ${group.containerName}`}
			class="scroll-mt-3 rounded-xl border bg-white shadow-sm transition-[border-color,box-shadow] dark:bg-[#3b4252] {focused ===
			group.grantId
				? 'border-[#b48ead] ring-2 ring-[#b48ead]/25'
				: 'border-[#d8dee9] dark:border-[#4c566a]'} {group.grant ? '' : 'opacity-70'}"
		>
			<header
				class="flex items-start gap-3 border-b border-[#d8dee9] px-4 py-3 dark:border-[#4c566a]"
			>
				<button
					type="button"
					aria-expanded={open}
					aria-label={open ? `Collapse ${group.containerName}` : `Expand ${group.containerName}`}
					onclick={() => toggle(group.grantId)}
					class="mt-0.5 rounded p-0.5 text-[#4c566a] hover:bg-[#e5e9f0] dark:text-[#d8dee9]/60 dark:hover:bg-[#434c5e]"
				>
					<ChevronDown size={16} class="transition-transform {open ? '' : '-rotate-90'}" />
				</button>
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-baseline gap-x-2">
						<h3 class="truncate font-semibold text-[#2e3440] dark:text-[#eceff4]">
							{group.containerName}
						</h3>
						{#if group.grant}
							<span class="text-xs text-[#4c566a] dark:text-[#d8dee9]/60">
								{group.grant.composeService ?? group.grant.kind} · as
								<span class="font-mono">{group.grant.user}</span>
							</span>
						{/if}
					</div>
					{#if group.grant?.intent}
						<p class="mt-1 text-sm text-[#86587f] dark:text-[#b48ead]" data-testid="brain-intent">
							<span class="text-[#4c566a] dark:text-[#d8dee9]/60">Working on&nbsp;</span>{group
								.grant.intent}
						</p>
					{/if}
					<div
						class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[#4c566a] dark:text-[#d8dee9]/60"
					>
						{#if group.grant}
							<span
								class="h-1 w-16 overflow-hidden rounded-full bg-[#d8dee9] dark:bg-[#4c566a]"
								aria-hidden="true"
							>
								<span
									class="block h-full rounded-full bg-[#b48ead]"
									style:width={`${remainingShare(group) * 100}%`}
								></span>
							</span>
							<span>{formatRemaining(group.grant.expiresAt, access.now)} left</span>
						{:else}
							<span>Grant ended</span>
						{/if}
						<span>· {group.steps.length} {group.steps.length === 1 ? 'command' : 'commands'}</span>
						{#if group.running}<span class="text-[#d08770] dark:text-[#ebcb8b]"
								>· {group.running} running</span
							>{/if}
						{#each group.shells as shell (shell.executionId)}
							<button
								type="button"
								onclick={() => onOpenTerminal(shell.executionId)}
								title="Open this shell in the terminal"
								class="flex items-center gap-1 rounded-full border border-[#d8dee9] px-2 py-0.5 font-mono hover:border-[#b48ead] hover:text-[#b48ead] dark:border-[#4c566a]"
							>
								<SquareTerminal size={11} />{shell.name}
								<span class="font-sans"
									>{shell.controller === 'operator' ? 'you' : shell.busy ? 'busy' : 'idle'}</span
								>
							</button>
						{/each}
					</div>
					{#if group.grant && !compact && group.grant.exposure.length}
						<details class="mt-1.5 text-xs text-[#4c566a] dark:text-[#d8dee9]/60">
							<summary class="cursor-pointer select-none">What this grant reaches</summary>
							<ul class="mt-1 grid gap-0.5 pl-4">
								{#each group.grant.exposure as item (item.message)}
									<li class={item.level === 'danger' ? 'text-[#bf616a]' : ''}>{item.message}</li>
								{/each}
							</ul>
						</details>
					{/if}
				</div>
				{#if group.grant}
					{@const grant = group.grant}
					<button
						type="button"
						disabled={Boolean(working)}
						onclick={() => void act(grant.id, () => access.revoke(grant.id))}
						class="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-[#bf616a] transition-colors hover:bg-[#bf616a]/10 disabled:opacity-50"
					>
						Revoke
					</button>
				{/if}
			</header>

			{#if open}
				{@const steps = stepsShown(group)}
				{#if steps.length}
					<ol
						class="relative px-4 pt-4 before:absolute before:top-6 before:bottom-8 before:left-[21.5px] before:w-px before:bg-[#d8dee9] dark:before:bg-[#4c566a]"
					>
						{#each steps as step (step.key)}
							<BrainCommandStep
								{step}
								{onOpenTerminal}
								working={working === step.executionId}
								onStop={(id) => void act(id, () => access.stop(id))}
							/>
						{/each}
					</ol>
				{:else}
					<p class="px-4 py-4 text-sm text-[#4c566a] dark:text-[#d8dee9]/70">
						No commands yet. Brain sees this container in its next list of targets.
					</p>
				{/if}
				{#if group.refused.length}
					<ul class="grid gap-1.5 border-t border-[#d8dee9] px-4 py-3 dark:border-[#4c566a]">
						{#each group.refused as entry (`${entry.at}-${entry.tool}`)}
							<li class="flex gap-2 text-xs">
								<TriangleAlert size={13} class="mt-0.5 shrink-0 text-[#bf616a]" />
								<span class="min-w-0 flex-1">
									{#if entry.goal}<span class="block text-[#2e3440] dark:text-[#eceff4]"
											>{entry.goal}</span
										>{/if}
									<span
										class="block truncate font-mono text-[#4c566a] dark:text-[#d8dee9]/60"
										title={entry.detail}>{entry.tool}: {entry.detail}</span
									>
									<span class="text-[#bf616a]"
										>{entry.outcome === 'denied' ? 'Refused' : 'Failed'}</span
									>
								</span>
								<time
									datetime={entry.at}
									class="shrink-0 font-mono text-[#4c566a] dark:text-[#d8dee9]/60"
									>{timeOf(entry.at)}</time
								>
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</section>
	{/each}

	{#if filter !== 'running' && activity.outside.length}
		<section
			class="rounded-xl border border-dashed border-[#bf616a]/50 px-4 py-3"
			aria-label="Refused outside granted containers"
		>
			<h3 class="flex items-center gap-2 text-sm font-semibold text-[#bf616a]">
				<ShieldAlert size={15} />Refused outside granted containers
			</h3>
			<ul class="mt-2 grid gap-2">
				{#each activity.outside.slice(0, 20) as entry (`${entry.at}-${entry.tool}`)}
					<li class="grid gap-0.5 text-xs">
						<span class="flex gap-2">
							<span class="min-w-0 flex-1 text-[#2e3440] dark:text-[#eceff4]"
								>{entry.goal ?? entry.tool}</span
							>
							<time datetime={entry.at} class="font-mono text-[#4c566a] dark:text-[#d8dee9]/60"
								>{timeOf(entry.at)}</time
							>
						</span>
						<code
							class="truncate font-mono text-[#4c566a] dark:text-[#d8dee9]/60"
							title={entry.detail}>{entry.detail}</code
						>
						<span class="text-[#bf616a]"
							>{entry.target ?? 'Unknown target'} · {entry.outcome === 'denied'
								? 'Refused'
								: 'Failed'}</span
						>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>
