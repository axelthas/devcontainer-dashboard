<script lang="ts">
	import { Ban, BrainCircuit, ChevronRight, Globe, Square, Terminal, X } from 'lucide-svelte';
	import { formatRemaining, type BrainAccess } from '$lib/brainAccess.svelte';
	import type { BrainAuditEntry, BrainExecutionStatus } from '$lib/brainTypes';
	import { errorMessage } from '$lib/requests';
	import BrainExecutionOutput from './BrainExecutionOutput.svelte';

	interface Props {
		access: BrainAccess;
	}

	let { access }: Props = $props();

	const uid = $props.id();
	const TOOLS = ['list_targets', 'execute', 'read_output', 'write_stdin', 'cancel_execution'];
	const STATUS_CLASS: Record<BrainExecutionStatus, string> = {
		running: 'text-[#d08770]',
		stopping: 'text-[#d08770]',
		exited: 'text-[#4c566a] dark:text-[#d8dee9]/70',
		stopped: 'text-[#4c566a] dark:text-[#d8dee9]/70',
		stop_unconfirmed: 'text-[#bf616a]',
		failed: 'text-[#bf616a]'
	};
	const OUTCOME_CLASS: Record<BrainAuditEntry['outcome'], string> = {
		ok: 'text-[#4c566a] dark:text-[#d8dee9]/60',
		denied: 'font-medium text-[#bf616a]',
		error: 'text-[#d08770]'
	};

	let dialog: HTMLDialogElement | undefined = $state();
	let selected = $state<string | null>(null);
	let working = $state('');
	let failure = $state('');

	const status = $derived(access.status);
	const grants = $derived(status?.grants ?? []);
	const executions = $derived(status?.executions ?? []);
	const audit = $derived(status?.audit ?? []);

	/** Run one operator action at a time and show its failure in the panel. */
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

	function revokeAll() {
		if (confirm('Revoke every Brain grant and stop the running commands?'))
			void act('all', () => access.revokeAll());
	}

	/** Exit code, stop result or failure, for one command. */
	function outcome(execution: (typeof executions)[number]): string {
		if (execution.status === 'exited') return `exit ${execution.exitCode}`;
		if (execution.status === 'stop_unconfirmed') return 'stop not confirmed';
		if (execution.status === 'running' && execution.controller === 'operator')
			return 'you have control';
		return execution.status;
	}

	/** Show the command's terminal tab in the drawer, and close this panel. */
	function openInTerminal(executionId: string) {
		access.reveal(executionId);
		dialog?.close();
	}
</script>

{#if status}
	<button
		type="button"
		onclick={() => dialog?.showModal()}
		title="Brain shell access"
		class="flex items-center gap-1.5 rounded-full border border-[#b48ead]/40 bg-[#b48ead]/10 px-3 py-1.5 text-sm font-medium text-[#b48ead] transition-colors hover:bg-[#b48ead]/20"
	>
		<BrainCircuit size={16} />
		<span
			>{status.enabled
				? `Brain · ${grants.length} ${grants.length === 1 ? 'grant' : 'grants'}`
				: 'Brain disabled'}</span
		>
	</button>

	<dialog
		bind:this={dialog}
		aria-labelledby={`${uid}-title`}
		class="my-0 mr-0 ml-auto h-dvh max-h-dvh w-full max-w-xl border-l border-[#d8dee9] bg-[#eceff4] p-0 text-[#2e3440] shadow-xl backdrop:bg-[#2e3440]/50 dark:border-[#4c566a] dark:bg-[#2e3440] dark:text-[#d8dee9]"
	>
		<div class="flex h-full flex-col">
			<div
				class="flex items-center justify-between gap-3 border-b border-[#d8dee9] bg-[#e5e9f0] px-5 py-4 dark:border-[#434c5e] dark:bg-[#3b4252]"
			>
				<h2 id={`${uid}-title`} class="flex items-center gap-2 text-base font-bold">
					<BrainCircuit size={18} class="text-[#b48ead]" />
					Brain shell access
				</h2>
				<button
					type="button"
					aria-label="Close"
					onclick={() => dialog?.close()}
					class="rounded p-1 text-[#4c566a] transition-colors hover:bg-[#d8dee9] dark:text-[#d8dee9]/60 dark:hover:bg-[#434c5e]"
				>
					<X size={16} />
				</button>
			</div>

			<div class="grid flex-1 content-start gap-6 overflow-y-auto px-5 py-4 text-sm">
				{#if failure}
					<p role="alert" class="text-xs text-[#bf616a]">{failure}</p>
				{/if}

				{#if !status.enabled}
					<section class="grid gap-3">
						<h3 class="font-semibold">Brain shell access is disabled</h3>
						<p class="text-xs">
							Add <code>--brain</code> to your production launcher command, then recreate the dashboard
							container. This creates a persistent token and a loopback-only MCP listener.
						</p>
						<pre
							class="overflow-auto rounded-lg bg-[#2e3440] p-3 font-mono text-xs text-[#d8dee9]">bash scripts/run-dashboard.sh --build --brain</pre>
						<p class="text-xs">
							For ClickUp access over the internet, also add <code>--brain-funnel</code> to your
							existing Tailscale launch command. It requires <code>--tailscale-socket</code>, an
							HTTPS <code>--origin</code>, and tailnet Funnel permission.
						</p>
						<p class="text-xs text-[#bf616a]">
							Funnel makes only the token-protected MCP endpoint public, not the dashboard. You must
							still grant access to each container.
						</p>
					</section>
				{:else}
					<section class="grid gap-2">
						<h3 class="text-xs font-semibold text-[#4c566a] uppercase dark:text-[#d8dee9]/60">
							Endpoint
						</h3>
						{#if status.publicUrl}
							<p class="flex items-center gap-2 font-mono text-xs break-all">
								<Globe size={14} class="shrink-0 text-[#88c0d0]" />{status.publicUrl}
							</p>
						{:else}
							<p class="text-xs text-[#4c566a] dark:text-[#d8dee9]/70">
								The MCP endpoint is running locally. Add --brain-funnel to your Tailscale launch
								command to publish it and show its connection URL here.
							</p>
						{/if}
						<p class="flex flex-wrap gap-1">
							{#each TOOLS as tool (tool)}
								<span
									class="rounded border border-[#d8dee9] px-1.5 py-0.5 font-mono text-xs dark:border-[#4c566a]"
									>{tool}</span
								>
							{/each}
						</p>
						<p class="text-xs text-[#4c566a] dark:text-[#d8dee9]/60">
							Brain cannot create grants. Commands can reach everything available inside a granted
							container, including its mounted sockets, credentials and networks.
						</p>
					</section>

					<section class="grid gap-2">
						<div class="flex items-center justify-between gap-2">
							<h3 class="text-xs font-semibold text-[#4c566a] uppercase dark:text-[#d8dee9]/60">
								Granted containers
							</h3>
							{#if grants.length > 0}
								<button
									type="button"
									disabled={Boolean(working)}
									onclick={revokeAll}
									class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-[#bf616a] transition-colors hover:bg-[#bf616a]/10 disabled:opacity-50"
								>
									<Ban size={12} />Revoke all
								</button>
							{/if}
						</div>
						{#if grants.length === 0}
							<p class="text-xs text-[#4c566a] dark:text-[#d8dee9]/70">
								No containers are granted. Use Grant Brain on a running container.
							</p>
						{:else}
							<ul class="grid gap-2">
								{#each grants as grant (grant.id)}
									<li
										class="flex items-center justify-between gap-3 rounded-lg border-l-4 border-[#b48ead] bg-white px-3 py-2 dark:bg-[#3b4252]"
									>
										<div class="min-w-0">
											<p class="truncate font-semibold">{grant.containerName}</p>
											<p class="text-xs text-[#4c566a] dark:text-[#d8dee9]/60">
												as <span class="font-mono">{grant.user}</span> · {formatRemaining(
													grant.expiresAt,
													access.now
												)} left · {grant.runningExecutions} running
											</p>
										</div>
										<button
											type="button"
											disabled={Boolean(working)}
											onclick={() => void act(grant.id, () => access.revoke(grant.id))}
											class="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-[#bf616a] transition-colors hover:bg-[#bf616a]/10 disabled:opacity-50"
										>
											Revoke
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</section>

					<section class="grid gap-2">
						<h3 class="text-xs font-semibold text-[#4c566a] uppercase dark:text-[#d8dee9]/60">
							Commands
						</h3>
						{#if executions.length === 0}
							<p class="text-xs text-[#4c566a] dark:text-[#d8dee9]/70">
								Brain has run no commands.
							</p>
						{:else}
							<ul class="grid gap-2">
								{#each executions as execution (execution.id)}
									<li class="grid gap-2 rounded-lg bg-white px-3 py-2 dark:bg-[#3b4252]">
										<div class="flex items-center gap-2">
											<button
												type="button"
												aria-expanded={selected === execution.id}
												aria-label={`Output: ${execution.command}`}
												onclick={() => (selected = selected === execution.id ? null : execution.id)}
												class="shrink-0 rounded p-0.5 text-[#4c566a] hover:bg-[#e5e9f0] dark:text-[#d8dee9]/60 dark:hover:bg-[#434c5e]"
											>
												<ChevronRight
													size={14}
													class="transition-transform {selected === execution.id
														? 'rotate-90'
														: ''}"
												/>
											</button>
											<code
												class="min-w-0 flex-1 truncate font-mono text-xs"
												title={execution.command}>{execution.command}</code
											>
											<span class="shrink-0 text-xs {STATUS_CLASS[execution.status]}"
												>{outcome(execution)}</span
											>
											<button
												type="button"
												title="Open in terminal"
												aria-label={`Open in terminal: ${execution.command}`}
												onclick={() => openInTerminal(execution.id)}
												class="shrink-0 rounded p-0.5 text-[#4c566a] transition-colors hover:bg-[#e5e9f0] hover:text-[#b48ead] dark:text-[#d8dee9]/60 dark:hover:bg-[#434c5e]"
											>
												<Terminal size={14} />
											</button>
											{#if execution.status === 'running'}
												<button
													type="button"
													disabled={Boolean(working)}
													onclick={() => void act(execution.id, () => access.stop(execution.id))}
													class="flex shrink-0 items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-[#bf616a] transition-colors hover:bg-[#bf616a]/10 disabled:opacity-50"
												>
													<Square size={10} />Stop
												</button>
											{/if}
										</div>
										<p class="text-xs text-[#4c566a] dark:text-[#d8dee9]/60">
											{execution.containerName} · as
											<span class="font-mono">{execution.user}</span>
											{#if execution.stopReason}· {execution.stopReason}{/if}
											{#if execution.error}· {execution.error}{/if}
										</p>
										{#if selected === execution.id}
											<BrainExecutionOutput executionId={execution.id} />
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</section>

					<section class="grid gap-2">
						<h3 class="text-xs font-semibold text-[#4c566a] uppercase dark:text-[#d8dee9]/60">
							Activity
						</h3>
						{#if audit.length === 0}
							<p class="text-xs text-[#4c566a] dark:text-[#d8dee9]/70">No activity yet.</p>
						{:else}
							<ol class="grid gap-1.5">
								{#each audit as entry, index (`${entry.at}-${index}`)}
									<li class="grid grid-cols-[max-content_1fr] gap-x-3 text-xs">
										<time
											datetime={entry.at}
											class="font-mono text-[#4c566a] dark:text-[#d8dee9]/60"
											>{new Date(entry.at).toLocaleTimeString()}</time
										>
										<span class="min-w-0">
											<span class="font-mono text-[#b48ead]">{entry.tool}</span>
											{#if entry.target}<span class="text-[#4c566a] dark:text-[#d8dee9]/60">
													→ {entry.target}</span
												>{/if}
											<span class="block truncate font-mono" title={entry.detail}
												>{entry.detail}</span
											>
											<span class={OUTCOME_CLASS[entry.outcome]}
												>{entry.outcome === 'denied' ? 'Refused' : entry.outcome}</span
											>
										</span>
									</li>
								{/each}
							</ol>
						{/if}
					</section>
				{/if}
			</div>
		</div>
	</dialog>
{/if}
