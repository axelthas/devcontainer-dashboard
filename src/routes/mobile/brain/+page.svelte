<script lang="ts">
	/**
	 * Brain tab: the phone form of the desktop split view. One inset group per granted
	 * container, with Brain's commands newest first and led by their goals. A tap opens the
	 * command screen; a terminal opens only when the operator asks for one there.
	 */
	import type { Attachment } from 'svelte/attachments';
	import { BrainCircuit, Check, Clock, ClockPlus, ShieldAlert, TriangleAlert } from 'lucide-svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { formatRemaining, useBrainAccess } from '$lib/brainAccess.svelte';
	import {
		buildActivity,
		grantEventText,
		headline,
		isRunningStep,
		stepOutcome,
		stepResult,
		timelineOf,
		type BrainActivityGroup,
		type BrainStep
	} from '$lib/brainActivity';
	import { clockTime, durationLabel, formatCountdown, isEndingSoon } from '$lib/brainAlerts';
	import { BRAIN_GRANT_MINUTES, type BrainGrantMinutes } from '$lib/brainTypes';
	import MButton from '$lib/components/mobile/MButton.svelte';
	import { errorMessage } from '$lib/requests';
	import MBrainStepIcon, { tone as stepTone } from '$lib/components/mobile/MBrainStepIcon.svelte';
	import MConfirm from '$lib/components/mobile/MConfirm.svelte';
	import MGroup from '$lib/components/mobile/MGroup.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';
	import MRow from '$lib/components/mobile/MRow.svelte';
	import MSegmented from '$lib/components/mobile/MSegmented.svelte';
	import MSheet from '$lib/components/mobile/MSheet.svelte';

	type Filter = 'all' | 'running' | 'problems';
	const brain = useBrainAccess();
	const activity = $derived(buildActivity(brain?.status ?? null));
	let filter = $state<Filter>('all');
	let revoking = $state<BrainActivityGroup | null>(null);
	/** Grant whose Extend access sheet is open, and the selected duration */
	let extending = $state<string | null>(null);
	let choice = $state<BrainGrantMinutes>(60);
	const extendGrant = $derived(
		brain?.status?.grants.find((grant) => grant.id === extending) ?? null
	);
	const anyEnding = $derived(
		(brain?.status?.grants ?? []).some((grant) => isEndingSoon(grant, brain?.now ?? Date.now()))
	);

	// Status polls run every five seconds; an ending grant's countdown ticks every second.
	$effect(() => {
		if (!anyEnding || !brain) return;
		const timer = setInterval(() => brain.tick(), 1000);
		return () => clearInterval(timer);
	});

	/** The `?extend=` link that already opened the sheet; status polls must not reopen it. */
	let handledLink = '';

	// The Brain strip's Extend button links here with ?extend=<grant>.
	$effect(() => {
		const requested = page.url.searchParams.get('extend') ?? '';
		if (!requested || requested === handledLink) return;
		if (!brain?.status?.grants.some((grant) => grant.id === requested)) return;
		handledLink = requested;
		openExtend(requested);
	});

	/** Open the sheet with Brain's requested duration, else one hour. */
	function openExtend(grantId: string) {
		const grant = brain?.status?.grants.find((item) => item.id === grantId);
		choice = grant?.timeRequest?.minutes ?? 60;
		failure = '';
		extending = grantId;
	}

	/** Extend by the selected duration; asks for notifications once. */
	async function confirmExtend(minutes: BrainGrantMinutes = choice) {
		const grantId = extending;
		if (!grantId || !brain || busy) return;
		busy = true;
		failure = '';
		void brain.enableNotifications();
		try {
			await brain.extend(grantId, minutes);
			extending = null;
		} catch (cause) {
			failure = errorMessage(cause);
		} finally {
			busy = false;
		}
	}

	/** Answer Brain's request directly from its row. */
	async function answerRequest(grantId: string, minutes: BrainGrantMinutes | null) {
		if (!brain || busy) return;
		busy = true;
		failure = '';
		try {
			if (minutes === null) await brain.dismissTimeRequest(grantId);
			else {
				void brain.enableNotifications();
				await brain.extend(grantId, minutes);
			}
		} catch (cause) {
			failure = errorMessage(cause);
		} finally {
			busy = false;
		}
	}
	let busy = $state(false);
	let failure = $state('');
	/** The group that the Brain strip asked for passes every filter. */
	const focused = $derived(brain?.focusRequest?.grantId ?? null);

	/** True when a group has a failed command or a refused call. */
	function hasProblems(group: BrainActivityGroup): boolean {
		return group.refused.length > 0 || group.steps.some((step) => stepOutcome(step) === 'failed');
	}

	const visible = $derived(
		activity.groups.filter((group) => {
			if (group.grantId === focused) return true;
			if (filter === 'running') return group.running > 0;
			if (filter === 'problems') return hasProblems(group);
			return true;
		})
	);
	const problemCount = $derived(activity.groups.filter(hasProblems).length);

	/** Newest first: on a phone the latest command is the one the operator looks for. */
	function stepsShown(group: BrainActivityGroup): BrainStep[] {
		const steps = filter === 'running' ? group.steps.filter(isRunningStep) : group.steps;
		return [...steps].reverse();
	}

	/** Command screen of a step; a shell command adds its command ID. */
	function stepHref(step: BrainStep): string {
		const base = resolve('/mobile/brain/[id]', { id: step.executionId });
		return step.commandId ? `${base}?command=${encodeURIComponent(step.commandId)}` : base;
	}

	function timeOf(at: string): string {
		return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	/** Grant state under the group: time left and the container user. */
	function footerOf(group: BrainActivityGroup): string {
		if (!group.grant) return 'Grant ended. Its commands stay visible.';
		return `${formatRemaining(group.grant.expiresAt, brain?.now ?? Date.now())} left · as ${group.grant.user}`;
	}

	/** Scroll to the group that the Brain strip asked for. */
	function scrollWhenFocused(grantId: string): Attachment<HTMLElement> {
		return (node) => {
			if (brain?.focusRequest?.grantId !== grantId) return;
			const frame = requestAnimationFrame(() =>
				node.scrollIntoView({ behavior: 'smooth', block: 'start' })
			);
			return () => cancelAnimationFrame(frame);
		};
	}

	async function confirmRevoke() {
		const grant = revoking?.grant;
		if (!grant || !brain || busy) return;
		busy = true;
		failure = '';
		try {
			await brain.revoke(grant.id);
			revoking = null;
		} catch (cause) {
			failure = errorMessage(cause);
		} finally {
			busy = false;
		}
	}
</script>

<MNavBar title="Brain" />

<div data-testid="brain-tab">
	{#if !brain?.status}
		<p class="px-8 py-8 text-center text-[15px] text-m-dim">Reading Brain status…</p>
	{:else if !brain.status.enabled}
		<p class="px-8 py-8 text-center text-[15px] text-m-dim">
			Brain shell access is disabled. Start the dashboard with --brain to enable it.
		</p>
	{:else}
		<MSegmented
			label="Show"
			value={filter}
			onChange={(value) => (filter = value)}
			options={[
				{ value: 'all', label: 'All' },
				{ value: 'running', label: activity.running ? `Running ${activity.running}` : 'Running' },
				{ value: 'problems', label: problemCount ? `Problems ${problemCount}` : 'Problems' }
			]}
		/>
		{#if activity.groups.length === 0}
			<p class="px-8 py-8 text-center text-[15px] text-m-dim">
				No containers are granted. Open a running container and use Grant Brain.
			</p>
		{:else if visible.length === 0}
			<p class="px-8 py-8 text-center text-[15px] text-m-dim">Nothing matches this filter.</p>
		{/if}

		{#each visible as group (group.grantId)}
			{@const steps = stepsShown(group)}
			<div
				{@attach scrollWhenFocused(group.grantId)}
				class="scroll-mt-4"
				data-brain-group={group.containerName}
			>
				<MGroup title={group.containerName} footer={footerOf(group)}>
					{#if group.grant && isEndingSoon(group.grant, brain.now)}
						<MRow
							title={`Access ends in ${formatCountdown(group.grant.expiresAt, brain.now)}`}
							subtitle={group.running
								? `${group.running} running ${group.running === 1 ? 'command stops' : 'commands stop'} at ${clockTime(group.grant.expiresAt)}`
								: `Brain loses access at ${clockTime(group.grant.expiresAt)}`}
							tone="bg-m-warn/15 text-m-warn"
							testid="brain-ending"
						>
							{#snippet icon()}<Clock size={16} aria-hidden="true" />{/snippet}
						</MRow>
					{/if}
					{#if group.grant?.timeRequest}
						{@const grant = group.grant}
						{@const request = group.grant.timeRequest}
						<div class="grid gap-3 bg-m-brain/10 px-4 py-3" data-testid="brain-time-request">
							<p class="flex items-center gap-2 text-[17px] font-semibold text-m-brain">
								<BrainCircuit size={18} aria-hidden="true" />Brain asks for {durationLabel(
									request.minutes
								)} more
							</p>
							<p class="text-[15px] leading-snug [overflow-wrap:anywhere]">{request.reason}</p>
							<div class="grid grid-cols-2 gap-2">
								<MButton
									disabled={busy}
									onclick={() => void answerRequest(grant.id, request.minutes)}
									>Extend {durationLabel(request.minutes)}</MButton
								>
								<MButton
									tone="plain"
									disabled={busy}
									onclick={() => void answerRequest(grant.id, null)}>Not now</MButton
								>
							</div>
						</div>
					{/if}
					{#if group.grant}
						{@const grant = group.grant}
						<MRow
							title="Extend access"
							subtitle={`Ends ${clockTime(grant.expiresAt)}`}
							onclick={() => openExtend(grant.id)}
							chevron
							tone="bg-m-frost text-m-on-frost"
							testid="brain-extend"
						>
							{#snippet icon()}<ClockPlus size={16} aria-hidden="true" />{/snippet}
						</MRow>
					{/if}
					{#if group.grant?.intent}
						<p
							class="px-4 py-3 text-[15px] leading-snug [overflow-wrap:anywhere]"
							data-testid="brain-intent"
						>
							<span class="text-m-dim">Working on&nbsp;</span><span class="text-m-brain"
								>{group.grant.intent}</span
							>
						</p>
					{/if}
					{#each timelineOf(steps, filter === 'running' ? [] : group.events).reverse() as item (item.key)}
						{#if item.kind === 'step'}
							{@const step = item.step}
							<MRow
								title={step.goal ?? headline(step.command)}
								subtitle={`${stepResult(step)} · ${timeOf(step.startedAt)}${step.shellName ? ` · shell ${step.shellName}` : ''}`}
								href={stepHref(step)}
								tone={stepTone(stepOutcome(step))}
								testid="brain-step"
							>
								{#snippet icon()}<MBrainStepIcon outcome={stepOutcome(step)} />{/snippet}
							</MRow>
						{:else}
							{@const text = grantEventText(item.entry)}
							<MRow
								title={text.title}
								subtitle={text.detail ? `${text.detail} · ${timeOf(item.at)}` : timeOf(item.at)}
								tone="bg-m-brain/15 text-m-brain"
								testid="brain-event"
							>
								{#snippet icon()}
									{#if item.entry.tool === 'request_more_time'}<BrainCircuit
											size={16}
											aria-hidden="true"
										/>{:else}<ClockPlus size={16} aria-hidden="true" />{/if}
								{/snippet}
							</MRow>
						{/if}
					{:else}
						<p class="px-4 py-3 text-[15px] text-m-dim">
							{filter === 'running' ? 'No running commands.' : 'No commands yet.'}
						</p>
					{/each}
					{#if filter !== 'running'}
						{#each group.refused as entry (`${entry.at}-${entry.tool}`)}
							<MRow
								title={entry.goal ?? entry.tool}
								subtitle={`${entry.outcome === 'denied' ? 'Refused' : 'Failed'} · ${entry.tool} · ${timeOf(entry.at)}`}
								tone="bg-m-stop/15 text-m-stop"
							>
								{#snippet icon()}<TriangleAlert size={16} aria-hidden="true" />{/snippet}
							</MRow>
						{/each}
					{/if}
					{#if group.grant}
						<MRow title="Revoke access" danger onclick={() => (revoking = group)} />
					{/if}
				</MGroup>
			</div>
		{/each}

		{#if filter !== 'running' && activity.outside.length}
			<MGroup title="Refused outside granted containers">
				{#each activity.outside.slice(0, 20) as entry (`${entry.at}-${entry.tool}`)}
					<MRow
						title={entry.goal ?? entry.tool}
						subtitle={`${entry.target ?? 'Unknown target'} · ${timeOf(entry.at)}`}
						tone="bg-m-stop/15 text-m-stop"
					>
						{#snippet icon()}<ShieldAlert size={16} aria-hidden="true" />{/snippet}
					</MRow>
				{/each}
			</MGroup>
		{/if}
	{/if}
</div>

<MSheet
	open={extendGrant !== null}
	title="Extend access"
	onClose={() => (extending = null)}
	closeDisabled={busy}
	testid="brain-extend-sheet"
>
	{#if extendGrant}
		<p class="px-8 pb-4 text-[15px] leading-snug text-m-dim">
			{extendGrant.containerName} · as {extendGrant.user}. Access ends at {clockTime(
				extendGrant.expiresAt
			)}.
		</p>
		<MGroup>
			{#each BRAIN_GRANT_MINUTES as minutes (minutes)}
				<MRow
					title={`${durationLabel(minutes)} more`}
					subtitle={`Until ${clockTime(Date.parse(extendGrant.expiresAt) + minutes * 60_000)}${extendGrant.timeRequest?.minutes === minutes ? ' · Brain asked for this' : ''}`}
					onclick={() => (choice = minutes)}
					testid="brain-extend-choice"
				>
					{#snippet trailing()}
						{#if choice === minutes}<Check
								size={20}
								class="shrink-0 text-m-frost"
								aria-label="Selected"
							/>{/if}
					{/snippet}
				</MRow>
			{/each}
		</MGroup>
		{#if failure}<p role="alert" class="px-8 pb-3 text-[15px] text-m-stop">{failure}</p>{/if}
		<div class="grid gap-2 px-4 pb-2">
			<MButton disabled={busy} onclick={() => void confirmExtend()} testid="brain-extend-confirm"
				>Extend by {durationLabel(choice)}</MButton
			>
			<MButton tone="plain" disabled={busy} onclick={() => (extending = null)}>Cancel</MButton>
		</div>
		<p class="px-8 pt-2 pb-4 text-[13px] leading-snug text-m-dim">
			Keeps the same container run, user and reach. Running commands continue.
		</p>
	{/if}
</MSheet>

<MSheet open={revoking !== null} title="Revoke" onClose={() => (revoking = null)}>
	<MConfirm
		title={`Revoke Brain access to ${revoking?.containerName ?? 'this container'}?`}
		body="Brain can no longer run commands in this container. Its running commands stop."
		action="Revoke access"
		keeps={['The container and its files', 'The command history in this list']}
		{busy}
		error={failure}
		onConfirm={() => void confirmRevoke()}
		onCancel={() => (revoking = null)}
	/>
</MSheet>
