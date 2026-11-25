<script lang="ts">
	/**
	 * Brain's work, grouped by granted container. Each group shows the grant and its time
	 * left, then the commands that Brain ran there, led by their goals. Calls that started no
	 * command show in their container, or under "Refused outside granted containers".
	 * The desktop Brain pane and the mobile Brain tab both use this view.
	 */
	import type { Attachment } from 'svelte/attachments';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		BrainCircuit,
		ChevronDown,
		Clock,
		ClockPlus,
		ShieldAlert,
		SquareTerminal,
		TriangleAlert
	} from 'lucide-svelte';
	import {
		buildActivity,
		grantEventText,
		isRunningStep,
		timelineOf,
		type BrainActivityGroup
	} from '$lib/brainActivity';
	import { formatRemaining, type BrainAccess } from '$lib/brainAccess.svelte';
	import { clockTime, durationLabel, formatCountdown, isEndingSoon } from '$lib/brainAlerts';
	import { BRAIN_GRANT_MINUTES, type BrainGrantMinutes } from '$lib/brainTypes';
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
	/** Grant whose Extend menu is open */
	let extendMenu = $state<string | null>(null);
	const anyEnding = $derived(
		activity.groups.some((group) => group.grant && isEndingSoon(group.grant, access.now))
	);

	// Status polls run every few seconds; the countdown of an ending grant ticks every second.
	$effect(() => {
		if (!anyEnding) return;
		const timer = setInterval(() => access.tick(), 1000);
		return () => clearInterval(timer);
	});
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

	/** Extend from the menu, the warning or Brain's request. Asks for notifications once. */
	function extendBy(grantId: string, minutes: BrainGrantMinutes) {
		extendMenu = null;
		void access.enableNotifications();
		void act(`extend:${grantId}`, () => access.extend(grantId, minutes));
	}

	/** `+15 min`, `+1 hour`, `+4 hours`. */
	function shortLabel(minutes: number): string {
		if (minutes < 60) return `+${minutes} min`;
		return minutes === 60 ? '+1 hour' : `+${minutes / 60} hours`;
	}

	/** End time after an extension: the minutes are added to the current end. */
	function endAfter(expiresAt: string, minutes: number): string {
		return clockTime(Date.parse(expiresAt) + minutes * 60_000);
	}

	/** A click outside the open Extend menu, or Escape, closes it. */
	function closeMenuOutside(event: MouseEvent) {
		if (extendMenu && !(event.target as Element | null)?.closest('[data-extend-menu]'))
			extendMenu = null;
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

	/** Durations offered in the ending warning; the menu offers all of them. */
	const QUICK: BrainGrantMinutes[] = [15, 60];

	const FILTERS: [Filter, string][] = [
		['all', 'All'],
		['running', 'Running'],
		['problems', 'Problems']
	];
</script>

<svelte:window
	onclick={closeMenuOutside}
	onkeydown={(event) => {
		if (event.key === 'Escape') extendMenu = null;
	}}
/>

<div class="grid min-w-0 grid-cols-1 content-start gap-4">
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
		{@const ending = Boolean(group.grant && isEndingSoon(group.grant, access.now))}
		<section
			{@attach scrollWhenFocused(group.grantId)}
			onpointerenter={() => onHoverGrant?.(group.grant?.containerId ?? null)}
			onpointerleave={() => onHoverGrant?.(null)}
			aria-label={`Brain in ${group.containerName}`}
			class="min-w-0 scroll-mt-3 rounded-xl border bg-white shadow-sm transition-[border-color,box-shadow] dark:bg-[#3b4252] {focused ===
			group.grantId
				? 'border-[#b48ead] ring-2 ring-[#b48ead]/25'
				: ending
					? 'border-[#ebcb8b]'
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
									class="block h-full rounded-full transition-[width] duration-700 {ending
										? 'bg-[#ebcb8b]'
										: 'bg-[#b48ead]'}"
									style:width={`${remainingShare(group) * 100}%`}
								></span>
							</span>
							<span class={ending ? 'font-semibold text-[#9a6b00] dark:text-[#ebcb8b]' : ''}
								>{formatRemaining(group.grant.expiresAt, access.now)} left · ends {clockTime(
									group.grant.expiresAt
								)}</span
							>
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
					<div class="relative flex shrink-0 items-center gap-1" data-extend-menu>
						<button
							type="button"
							aria-haspopup="menu"
							aria-expanded={extendMenu === grant.id}
							disabled={Boolean(working)}
							onclick={() => (extendMenu = extendMenu === grant.id ? null : grant.id)}
							class="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 {ending
								? 'border-[#5e81ac] bg-[#5e81ac] text-white hover:opacity-90 dark:border-[#88c0d0] dark:bg-[#88c0d0] dark:text-[#2e3440]'
								: 'border-[#d8dee9] text-[#2e3440] hover:bg-[#e5e9f0] dark:border-[#4c566a] dark:text-[#eceff4] dark:hover:bg-[#434c5e]'}"
						>
							<ClockPlus size={12} />Extend<ChevronDown size={12} />
						</button>
						<button
							type="button"
							disabled={Boolean(working)}
							onclick={() => void act(grant.id, () => access.revoke(grant.id))}
							class="rounded-lg px-2 py-1 text-xs font-medium text-[#bf616a] transition-colors hover:bg-[#bf616a]/10 disabled:opacity-50"
						>
							Revoke
						</button>
						{#if extendMenu === grant.id}
							<div
								role="menu"
								aria-label={`Extend access to ${group.containerName}`}
								class="absolute top-full right-0 z-20 mt-1 grid w-64 gap-0.5 rounded-lg border border-[#d8dee9] bg-white p-1.5 text-xs shadow-xl dark:border-[#4c566a] dark:bg-[#3b4252]"
							>
								<p class="px-2 pt-1 pb-1.5 font-semibold text-[#4c566a] dark:text-[#d8dee9]/70">
									Extend access
								</p>
								{#each BRAIN_GRANT_MINUTES as minutes (minutes)}
									{@const asked = grant.timeRequest?.minutes === minutes}
									<button
										type="button"
										role="menuitem"
										onclick={() => extendBy(grant.id, minutes)}
										class="grid grid-cols-[1fr_auto] items-baseline gap-x-3 rounded-md px-2 py-1.5 text-left hover:bg-[#e5e9f0] dark:hover:bg-[#434c5e] {asked
											? 'bg-[#b48ead]/10'
											: ''}"
									>
										<span class="text-sm font-semibold text-[#2e3440] dark:text-[#eceff4]"
											>{shortLabel(minutes)}</span
										>
										<span class="text-[#4c566a] tabular-nums dark:text-[#d8dee9]/60"
											>until {endAfter(grant.expiresAt, minutes)}</span
										>
										{#if asked}<span class="col-span-2 text-[#86587f] dark:text-[#b48ead]"
												>Brain asked for this</span
											>{/if}
									</button>
								{/each}
								<p class="px-2 pt-1.5 pb-1 leading-snug text-[#4c566a] dark:text-[#d8dee9]/60">
									Same container run, user and reach. Running commands continue.
								</p>
							</div>
						{/if}
					</div>
				{/if}
			</header>

			{#if group.grant && ending}
				{@const grant = group.grant}
				<div
					role="status"
					class="flex flex-wrap items-center gap-2 border-b border-[#ebcb8b]/50 bg-[#ebcb8b]/20 px-4 py-2 text-xs text-[#2e3440] dark:bg-[#ebcb8b]/10 dark:text-[#eceff4]"
					data-testid="brain-ending"
				>
					<Clock size={14} class="shrink-0 text-[#9a6b00] dark:text-[#ebcb8b]" />
					<span class="min-w-0 flex-1">
						Access ends in
						<strong class="text-[#9a6b00] tabular-nums dark:text-[#ebcb8b]"
							>{formatCountdown(grant.expiresAt, access.now)}</strong
						>.
						{group.running
							? `${group.running} running ${group.running === 1 ? 'command stops' : 'commands stop'} at ${clockTime(grant.expiresAt)}.`
							: 'Brain loses access then.'}
					</span>
					{#each QUICK as minutes (minutes)}
						<button
							type="button"
							disabled={Boolean(working)}
							onclick={() => extendBy(grant.id, minutes)}
							class="rounded-lg border border-[#ebcb8b] px-2 py-0.5 font-semibold text-[#9a6b00] hover:bg-[#ebcb8b]/20 disabled:opacity-50 dark:text-[#ebcb8b]"
						>
							{shortLabel(minutes)}
						</button>
					{/each}
				</div>
			{/if}

			{#if group.grant?.timeRequest}
				{@const grant = group.grant}
				{@const request = group.grant.timeRequest}
				<div
					class="mx-4 mt-3 grid min-w-0 gap-2 rounded-lg border border-[#b48ead]/50 bg-[#b48ead]/10 px-3 py-2.5 text-xs"
					data-testid="brain-time-request"
				>
					<p
						class="flex items-center gap-2 text-sm font-semibold text-[#86587f] dark:text-[#b48ead]"
					>
						<BrainCircuit size={14} class="shrink-0" />Brain asks for {durationLabel(
							request.minutes
						)} more
						<time
							datetime={request.at}
							class="ml-auto font-mono text-xs font-normal text-[#4c566a] dark:text-[#d8dee9]/60"
							>{timeOf(request.at)}</time
						>
					</p>
					<p class="text-sm [overflow-wrap:anywhere] text-[#2e3440] dark:text-[#eceff4]">
						{request.reason}
					</p>
					<div class="flex flex-wrap gap-1.5">
						<button
							type="button"
							disabled={Boolean(working)}
							onclick={() => extendBy(grant.id, request.minutes)}
							class="rounded-lg bg-[#5e81ac] px-2.5 py-1 font-semibold text-white hover:opacity-90 disabled:opacity-50 dark:bg-[#88c0d0] dark:text-[#2e3440]"
						>
							Extend by {durationLabel(request.minutes)} · until {endAfter(
								grant.expiresAt,
								request.minutes
							)}
						</button>
						<button
							type="button"
							data-extend-menu
							disabled={Boolean(working)}
							onclick={() => (extendMenu = grant.id)}
							class="rounded-lg border border-[#d8dee9] px-2.5 py-1 font-semibold hover:bg-[#e5e9f0] disabled:opacity-50 dark:border-[#4c566a] dark:hover:bg-[#434c5e]"
						>
							Other duration
						</button>
						<button
							type="button"
							disabled={Boolean(working)}
							onclick={() =>
								void act(`dismiss:${grant.id}`, () => access.dismissTimeRequest(grant.id))}
							class="rounded-lg border border-[#d8dee9] px-2.5 py-1 font-semibold hover:bg-[#e5e9f0] disabled:opacity-50 dark:border-[#4c566a] dark:hover:bg-[#434c5e]"
						>
							Dismiss
						</button>
					</div>
					<p class="text-[#4c566a] dark:text-[#d8dee9]/60">
						Brain cannot extend access itself. Dismiss tells Brain no.
					</p>
				</div>
			{/if}

			{#if open}
				{@const steps = stepsShown(group)}
				{@const timeline = timelineOf(steps, filter === 'running' ? [] : group.events)}
				{#if timeline.length}
					<ol
						class="relative min-w-0 px-4 pt-4 before:absolute before:top-6 before:bottom-8 before:left-[21.5px] before:w-px before:bg-[#d8dee9] dark:before:bg-[#4c566a]"
					>
						{#each timeline as item (item.key)}
							{#if item.kind === 'step'}
								<BrainCommandStep
									step={item.step}
									{onOpenTerminal}
									working={working === item.step.executionId}
									onStop={(id) => void act(id, () => access.stop(id))}
								/>
							{:else}
								{@const text = grantEventText(item.entry)}
								<li class="relative flex gap-3" data-brain-event={item.entry.tool}>
									<span
										class="relative mt-1 flex size-3 shrink-0 items-center justify-center"
										aria-hidden="true"
									>
										{#if item.entry.tool === 'request_more_time'}
											<BrainCircuit
												size={13}
												class="rounded-full bg-white text-[#b48ead] ring-4 ring-white dark:bg-[#3b4252] dark:ring-[#3b4252]"
											/>
										{:else}
											<ClockPlus
												size={13}
												class="rounded-full bg-white text-[#b48ead] ring-4 ring-white dark:bg-[#3b4252] dark:ring-[#3b4252]"
											/>
										{/if}
									</span>
									<div class="min-w-0 flex-1 pb-4">
										<p class="text-sm text-[#86587f] dark:text-[#b48ead]">{text.title}</p>
										{#if text.detail}
											<p
												class="mt-0.5 text-xs [overflow-wrap:anywhere] text-[#4c566a] dark:text-[#d8dee9]/60"
											>
												{text.detail}
											</p>
										{/if}
									</div>
									<time
										datetime={item.at}
										class="shrink-0 font-mono text-xs text-[#4c566a] dark:text-[#d8dee9]/60"
										>{timeOf(item.at)}</time
									>
								</li>
							{/if}
						{/each}
					</ol>
				{:else}
					<p class="px-4 py-4 text-sm text-[#4c566a] dark:text-[#d8dee9]/70">
						No commands yet. Brain sees this container in its next list of targets.
					</p>
				{/if}
				{#if group.refused.length}
					<ul
						class="grid min-w-0 grid-cols-1 gap-1.5 border-t border-[#d8dee9] px-4 py-3 dark:border-[#4c566a]"
					>
						{#each group.refused as entry (`${entry.at}-${entry.tool}`)}
							<li class="flex min-w-0 gap-2 text-xs">
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
			class="min-w-0 rounded-xl border border-dashed border-[#bf616a]/50 px-4 py-3"
			aria-label="Refused outside granted containers"
		>
			<h3 class="flex items-center gap-2 text-sm font-semibold text-[#bf616a]">
				<ShieldAlert size={15} />Refused outside granted containers
			</h3>
			<ul class="mt-2 grid min-w-0 grid-cols-1 gap-2">
				{#each activity.outside.slice(0, 20) as entry (`${entry.at}-${entry.tool}`)}
					<li class="grid min-w-0 grid-cols-1 gap-0.5 text-xs">
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
