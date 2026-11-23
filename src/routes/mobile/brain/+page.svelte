<script lang="ts">
	/**
	 * Brain tab: the phone form of the desktop split view. One inset group per granted
	 * container, with Brain's commands newest first and led by their goals. A tap opens the
	 * command screen; a terminal opens only when the operator asks for one there.
	 */
	import type { Attachment } from 'svelte/attachments';
	import { ShieldAlert, TriangleAlert } from 'lucide-svelte';
	import { resolve } from '$app/paths';
	import { formatRemaining, useBrainAccess } from '$lib/brainAccess.svelte';
	import {
		buildActivity,
		headline,
		isRunningStep,
		stepOutcome,
		stepResult,
		type BrainActivityGroup,
		type BrainStep
	} from '$lib/brainActivity';
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
					{#each steps as step (step.key)}
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
