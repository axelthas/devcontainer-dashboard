<script lang="ts">
	/**
	 * One Brain command on the phone: the goal leads, then the command and its output.
	 * The terminal opens only from Open in terminal. A shell command is selected by `?command=`.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useBrainAccess } from '$lib/brainAccess.svelte';
	import { buildActivity, findStep, stepOutcome, stepResult } from '$lib/brainActivity';
	import { errorMessage } from '$lib/requests';
	import BrainExecutionOutput from '$lib/components/BrainExecutionOutput.svelte';
	import MBrainStepIcon, { tone } from '$lib/components/mobile/MBrainStepIcon.svelte';
	import MButton from '$lib/components/mobile/MButton.svelte';
	import MGroup from '$lib/components/mobile/MGroup.svelte';
	import MNavBar from '$lib/components/mobile/MNavBar.svelte';

	const brain = useBrainAccess();
	const executionId = $derived(page.params.id ?? '');
	const commandId = $derived(page.url.searchParams.get('command'));
	const found = $derived(findStep(buildActivity(brain?.status ?? null), executionId, commandId));
	const step = $derived(found?.step);
	const outcome = $derived(step ? stepOutcome(step) : 'ended');
	const problems = $derived(step?.trail.filter((entry) => entry.outcome !== 'ok') ?? []);
	let copied = $state(false);
	let stopping = $state(false);
	let failure = $state('');

	function timeOf(at: string): string {
		return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	async function copyCommand() {
		if (!step) return;
		try {
			await navigator.clipboard.writeText(step.command);
			copied = true;
		} catch {
			// Clipboard access needs a secure context; the full command is visible above.
		}
	}

	async function stop() {
		if (!brain || !step || stopping) return;
		stopping = true;
		failure = '';
		try {
			await brain.stop(step.executionId);
		} catch (cause) {
			failure = errorMessage(cause);
		} finally {
			stopping = false;
		}
	}
</script>

<MNavBar back={{ href: resolve('/mobile/brain'), label: 'Brain' }} />

{#if !brain?.status}
	<p class="px-8 py-12 text-center text-[16px] text-m-dim">Reading Brain status…</p>
{:else if !step || !found}
	<p class="px-8 py-12 text-center text-[16px] text-m-dim" data-testid="brain-step-missing">
		This Brain command is no longer listed.
	</p>
{:else}
	<div class="px-5 pt-1 pb-5" data-testid="brain-step-screen">
		<div class="flex items-center gap-2 text-[15px] text-m-dim" role="status">
			<span class="flex size-6 items-center justify-center rounded-[7px] {tone(outcome)}">
				<MBrainStepIcon {outcome} />
			</span>
			<span class="font-mono">{stepResult(step)}</span>
			<span>· {timeOf(step.startedAt)}</span>
		</div>
		<h2 class="mt-2 text-[24px] leading-tight font-bold [overflow-wrap:anywhere]">
			{step.goal ?? 'Brain gave no goal for this command.'}
		</h2>
		<p class="mt-1 text-[15px] [overflow-wrap:anywhere] text-m-dim">
			{found.group.containerName}{step.shellName ? ` · shell ${step.shellName}` : ''}
		</p>
		{#if step.note}
			<p class="mt-2 text-[15px] [overflow-wrap:anywhere] text-m-dim italic">{step.note}</p>
		{/if}
	</div>

	<MGroup title="Command">
		<pre
			class="max-h-48 overflow-auto px-4 py-3 font-mono text-[14px] leading-snug [overflow-wrap:anywhere] whitespace-pre-wrap">{step.command}</pre>
	</MGroup>

	<MGroup title="Output">
		<div class="p-2">
			<BrainExecutionOutput executionId={step.executionId} commandId={step.commandId} tall />
		</div>
	</MGroup>

	{#if problems.length}
		<MGroup title="Refused calls">
			{#each problems as problem (`${problem.at}-${problem.tool}`)}
				<p class="px-4 py-3 text-[15px] [overflow-wrap:anywhere] text-m-stop">
					<span class="font-mono">{problem.tool}</span> refused: {problem.detail}
				</p>
			{/each}
		</MGroup>
	{/if}

	<div class="grid gap-3 px-4 pb-6">
		{#if failure}<p role="alert" class="text-[15px] text-m-stop">{failure}</p>{/if}
		<MButton
			tone="brain"
			onclick={() => {
				brain.openTab(step.executionId);
				void goto(resolve('/mobile/terminals/brain/[id]', { id: step.executionId }));
			}}
			testid="brain-open-terminal"
		>
			{outcome === 'running' ? 'Open terminal to take over' : 'Open in terminal'}
		</MButton>
		<MButton tone="plain" onclick={() => void copyCommand()}>
			{copied ? 'Command copied' : 'Copy command'}
		</MButton>
		{#if outcome === 'running' && !step.commandId}
			<MButton tone="danger" disabled={stopping} onclick={() => void stop()}>Stop command</MButton>
		{/if}
	</div>
{/if}
