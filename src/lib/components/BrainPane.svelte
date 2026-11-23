<script lang="ts">
	/**
	 * Right half of the dashboard split view: what Brain does, while the dashboard stays
	 * usable on the left. It has no overlay and needs no dismissal; Close collapses the split.
	 * The endpoint details and the Brain setup instructions live here as well.
	 */
	import { Ban, BrainCircuit, Globe, Radio, X } from 'lucide-svelte';
	import type { BrainAccess } from '$lib/brainAccess.svelte';
	import { buildActivity } from '$lib/brainActivity';
	import { errorMessage } from '$lib/requests';
	import BrainActivity from './BrainActivity.svelte';

	interface Props {
		access: BrainAccess;
		/** Brain share of the page width, when the split shows */
		width: number;
		onResize: (width: number) => void;
		onClose: () => void;
		onOpenTerminal: (executionId: string) => void;
		onHoverGrant?: (containerId: string | null) => void;
	}

	let { access, width, onResize, onClose, onOpenTerminal, onHoverGrant }: Props = $props();

	const uid = $props.id();
	const TOOLS = [
		'list_targets',
		'open_shell',
		'execute',
		'read_output',
		'write_stdin',
		'cancel_execution'
	];
	const PRESETS: [string, number][] = [
		['⅓', 1 / 3],
		['½', 1 / 2],
		['⅔', 2 / 3]
	];
	const status = $derived(access.status);
	const running = $derived(buildActivity(status).running);
	let failure = $state('');
	let revoking = $state(false);

	async function revokeAll() {
		if (revoking || !confirm('Revoke every Brain grant and stop the running commands?')) return;
		revoking = true;
		failure = '';
		try {
			await access.revokeAll();
		} catch (cause) {
			failure = errorMessage(cause);
		} finally {
			revoking = false;
		}
	}
</script>

<section
	aria-labelledby={`${uid}-title`}
	class="flex h-full min-h-0 flex-col bg-[#eceff4] text-[#2e3440] dark:bg-[#2e3440] dark:text-[#d8dee9]"
>
	<div
		class="flex flex-wrap items-center gap-2 border-b border-[#d8dee9] bg-[#e5e9f0] px-5 py-3 dark:border-[#434c5e] dark:bg-[#3b4252]"
	>
		<h2 id={`${uid}-title`} class="flex items-center gap-2 text-base font-bold">
			<BrainCircuit size={18} class="text-[#b48ead]" />Brain
		</h2>
		{#if running}
			<span
				class="flex items-center gap-1.5 rounded-full bg-[#ebcb8b]/20 px-2 py-0.5 text-xs font-medium text-[#d08770] dark:text-[#ebcb8b]"
			>
				<Radio size={12} class="animate-pulse" />{running} running
			</span>
		{/if}
		<div class="ml-auto flex items-center gap-1">
			{#if status?.enabled}
				<details class="relative">
					<summary
						class="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-[#4c566a] hover:bg-[#d8dee9] dark:text-[#d8dee9]/70 dark:hover:bg-[#434c5e]"
						title="MCP endpoint"
					>
						<Globe size={14} class="text-[#5e81ac] dark:text-[#88c0d0]" />Endpoint
					</summary>
					<div
						class="absolute right-0 z-20 mt-1 grid w-80 gap-2 rounded-lg border border-[#d8dee9] bg-white p-3 text-xs shadow-xl dark:border-[#4c566a] dark:bg-[#3b4252]"
					>
						{#if status.publicUrl}
							<p class="font-mono break-all">{status.publicUrl}</p>
						{:else}
							<p>
								The MCP endpoint runs locally. Add --brain-funnel to your Tailscale launch command
								to publish it and show its URL here.
							</p>
						{/if}
						<p class="flex flex-wrap gap-1">
							{#each TOOLS as tool (tool)}
								<span
									class="rounded border border-[#d8dee9] px-1.5 py-0.5 font-mono dark:border-[#4c566a]"
									>{tool}</span
								>
							{/each}
						</p>
						<p class="text-[#4c566a] dark:text-[#d8dee9]/60">
							Brain cannot create grants. Commands can reach everything available inside a granted
							container, including its mounted sockets, credentials and networks.
						</p>
					</div>
				</details>
			{/if}
			<div
				class="hidden rounded-lg border border-[#d8dee9] p-0.5 lg:flex dark:border-[#4c566a]"
				role="group"
				aria-label="Brain pane width"
			>
				{#each PRESETS as [label, value] (label)}
					<button
						type="button"
						aria-pressed={Math.abs(width - value) < 0.01}
						aria-label={`Brain uses ${label} of the width`}
						onclick={() => onResize(value)}
						class="rounded px-1.5 text-xs {Math.abs(width - value) < 0.01
							? 'bg-[#b48ead]/20 text-[#b48ead]'
							: 'text-[#4c566a] hover:text-[#2e3440] dark:text-[#d8dee9]/60 dark:hover:text-[#eceff4]'}"
					>
						{label}
					</button>
				{/each}
			</div>
			{#if status?.grants.length}
				<button
					type="button"
					disabled={revoking}
					onclick={revokeAll}
					class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-[#bf616a] transition-colors hover:bg-[#bf616a]/10 disabled:opacity-50"
				>
					<Ban size={12} />Revoke all
				</button>
			{/if}
			<button
				type="button"
				aria-label="Close the Brain pane"
				title="Close the Brain pane. Commands continue."
				onclick={onClose}
				class="rounded p-1 text-[#4c566a] transition-colors hover:bg-[#d8dee9] dark:text-[#d8dee9]/60 dark:hover:bg-[#434c5e]"
			>
				<X size={16} />
			</button>
		</div>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-24 text-sm">
		{#if failure}
			<p role="alert" class="mb-3 text-xs text-[#bf616a]">{failure}</p>
		{/if}
		{#if !status}
			<p class="py-6 text-center text-[#4c566a] dark:text-[#d8dee9]/70">Reading Brain status…</p>
		{:else if !status.enabled}
			<section class="grid gap-3">
				<h3 class="font-semibold">Brain shell access is disabled</h3>
				<p class="text-xs">
					Add <code>--brain</code> to your production launcher command, then recreate the dashboard container.
					This creates a persistent token and a loopback-only MCP listener.
				</p>
				<pre
					class="overflow-auto rounded-lg bg-[#2e3440] p-3 font-mono text-xs text-[#d8dee9]">bash scripts/run-dashboard.sh --build --brain</pre>
				<p class="text-xs">
					For ClickUp access over the internet, also add <code>--brain-funnel</code> to your
					existing Tailscale launch command. It requires <code>--tailscale-socket</code>, an HTTPS
					<code>--origin</code>, and tailnet Funnel permission.
				</p>
				<p class="text-xs text-[#bf616a]">
					Funnel makes only the token-protected MCP endpoint public, not the dashboard. You must
					still grant access to each container.
				</p>
			</section>
		{:else}
			<BrainActivity {access} {onOpenTerminal} {onHoverGrant} />
		{/if}
	</div>
</section>
