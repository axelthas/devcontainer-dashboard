<script lang="ts">
	/**
	 * One Brain command in the Brain pane: the goal that Brain gave leads, the shell line
	 * follows. Expanding shows the full command and its retained output. No terminal opens
	 * unless the operator asks for one.
	 */
	import {
		ChevronRight,
		Copy,
		Eye,
		Keyboard,
		Square,
		SquareTerminal,
		TriangleAlert
	} from 'lucide-svelte';
	import { headline, isRunningStep, type BrainStep } from '$lib/brainActivity';
	import BrainExecutionOutput from './BrainExecutionOutput.svelte';

	interface Props {
		step: BrainStep;
		/** Show the terminal for this command; the command continues when it closes */
		onOpenTerminal: (executionId: string) => void;
		/** Stop a one-off command. Shell commands stop from their terminal. */
		onStop?: (executionId: string) => void;
		working?: boolean;
	}

	let { step, onOpenTerminal, onStop, working = false }: Props = $props();

	const uid = $props.id();
	const running = $derived(isRunningStep(step));
	// A running command starts expanded, so its live output is visible at once.
	let expanded = $state<boolean | null>(null);
	const open = $derived(expanded ?? running);
	const reads = $derived(step.trail.filter((entry) => entry.tool === 'read_output').length);
	const writes = $derived(step.trail.filter((entry) => entry.tool === 'write_stdin').length);
	const problems = $derived(step.trail.filter((entry) => entry.outcome !== 'ok'));
	const time = $derived(
		new Date(step.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
	);

	/** Exit code, live state or stop result. */
	function result(): string {
		if (step.status === 'running')
			return step.controller === 'operator' ? 'you have control' : 'running';
		if (step.status === 'exited') return `exit ${step.exitCode ?? '?'}`;
		if (step.status === 'stop_unconfirmed') return 'stop not confirmed';
		return step.status;
	}

	const dotClass = $derived(
		running
			? 'bg-[#ebcb8b]'
			: step.status === 'exited' && step.exitCode === 0
				? 'bg-[#a3be8c]'
				: step.status === 'exited' || step.status === 'failed'
					? 'bg-[#bf616a]'
					: 'bg-[#4c566a] dark:bg-[#d8dee9]/50'
	);
	const resultClass = $derived(
		running
			? 'text-[#d08770] dark:text-[#ebcb8b]'
			: step.status === 'exited' && step.exitCode === 0
				? 'text-[#4c566a] dark:text-[#d8dee9]/60'
				: 'text-[#bf616a]'
	);

	async function copyCommand() {
		try {
			await navigator.clipboard.writeText(step.command);
		} catch {
			// Clipboard access needs a secure context; the full command is visible above.
		}
	}
</script>

<li class="relative flex gap-3" data-brain-step={step.key} data-running={running ? '' : undefined}>
	<span class="relative mt-1.5 flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
		{#if running}<span class="absolute inset-0 animate-ping rounded-full bg-[#ebcb8b]/60"
			></span>{/if}
		<span class="relative size-2.5 rounded-full ring-4 ring-white dark:ring-[#3b4252] {dotClass}"
		></span>
	</span>
	<div class="min-w-0 flex-1 pb-4">
		<button
			type="button"
			aria-expanded={open}
			aria-controls={`${uid}-detail`}
			onclick={() => (expanded = !open)}
			class="group grid w-full gap-1 text-left"
		>
			<span class="flex items-start gap-2">
				<span class="flex-1 text-sm leading-snug text-[#2e3440] dark:text-[#eceff4]">
					{#if step.goal}{step.goal}{:else}<span
							class="text-[#4c566a] italic dark:text-[#d8dee9]/60"
							>Brain gave no goal for this command.</span
						>{/if}
				</span>
				<time
					datetime={step.startedAt}
					class="shrink-0 pt-0.5 font-mono text-xs text-[#4c566a] dark:text-[#d8dee9]/60"
					>{time}</time
				>
			</span>
			<span class="flex min-w-0 items-center gap-2">
				<ChevronRight
					size={14}
					class="shrink-0 text-[#4c566a] transition-transform dark:text-[#d8dee9]/60 {open
						? 'rotate-90'
						: ''}"
				/>
				<code
					class="min-w-0 flex-1 truncate font-mono text-xs text-[#5e81ac] group-hover:text-[#2e3440] dark:text-[#88c0d0] dark:group-hover:text-[#8fbcbb]"
					title={step.command}>{headline(step.command)}</code
				>
			</span>
			<span class="flex flex-wrap items-center gap-x-3 gap-y-1 pl-5 text-xs">
				<span class="font-mono {resultClass}">{result()}</span>
				{#if step.shellName}
					<span class="text-[#4c566a] dark:text-[#d8dee9]/60"
						>in shell <span class="font-mono">{step.shellName}</span></span
					>
				{/if}
				{#if reads}
					<span
						class="flex items-center gap-1 text-[#4c566a] dark:text-[#d8dee9]/60"
						title="read_output calls"
					>
						<Eye size={12} />read output{reads > 1 ? ` ×${reads}` : ''}
					</span>
				{/if}
				{#if writes}
					<span
						class="flex items-center gap-1 text-[#4c566a] dark:text-[#d8dee9]/60"
						title="write_stdin calls"
					>
						<Keyboard size={12} />stdin ×{writes}
					</span>
				{/if}
				{#if problems.length}
					<span class="flex items-center gap-1 text-[#bf616a]">
						<TriangleAlert size={12} />{problems.length} refused
					</span>
				{/if}
			</span>
			{#if step.note}
				<span class="pl-5 text-xs text-[#4c566a] italic dark:text-[#d8dee9]/60">{step.note}</span>
			{/if}
		</button>

		{#if open}
			<div id={`${uid}-detail`} class="mt-2 ml-5 grid gap-2">
				<pre
					class="max-h-40 overflow-auto rounded-lg bg-[#2e3440] px-3 py-2 font-mono text-xs whitespace-pre-wrap text-[#d8dee9] dark:bg-[#242933]"><span
						class="text-[#d8dee9]/40 select-none"
						>$ </span>{step.command}</pre>
				<BrainExecutionOutput executionId={step.executionId} commandId={step.commandId} />
				{#each problems as problem (`${problem.at}-${problem.tool}`)}
					<p class="text-xs text-[#bf616a]">
						<span class="font-mono">{problem.tool}</span> refused: {problem.detail}
					</p>
				{/each}
				<div class="flex flex-wrap items-center gap-1">
					<button
						type="button"
						onclick={() => onOpenTerminal(step.executionId)}
						class="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#b48ead] dark:text-[#d8dee9]/70 dark:hover:bg-[#434c5e]"
					>
						<SquareTerminal size={14} />{running
							? 'Open terminal to take over'
							: 'Open in terminal'}
					</button>
					<button
						type="button"
						onclick={copyCommand}
						class="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-[#4c566a] transition-colors hover:bg-[#e5e9f0] dark:text-[#d8dee9]/70 dark:hover:bg-[#434c5e]"
					>
						<Copy size={14} />Copy command
					</button>
					{#if running && onStop && !step.commandId}
						<button
							type="button"
							disabled={working || step.status === 'stopping'}
							onclick={() => onStop(step.executionId)}
							class="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-[#bf616a] transition-colors hover:bg-[#bf616a]/10 disabled:opacity-50"
						>
							<Square size={10} />Stop
						</button>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</li>
