<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import {
		X,
		Plus,
		Terminal,
		ChevronDown,
		ChevronUp,
		Maximize2,
		Minimize2,
		BrainCircuit
	} from 'lucide-svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import TerminalTab from './TerminalTab.svelte';
	import BrainTerminalTab from './BrainTerminalTab.svelte';
	import TerminalEngineSwitcher from './TerminalEngineSwitcher.svelte';
	import { generateId } from '$lib/index';
	import {
		brainExecutionIdOf,
		brainTabId,
		isRunningStatus,
		useBrainAccess
	} from '$lib/brainAccess.svelte';
	import type { BrainExecutionView } from '$lib/brainTypes';
	import type { TerminalSession } from '$lib/types';
	import type { TerminalEngineId, TerminalViewIdentity } from '$lib/terminalView';
	import {
		preferredTerminalEngine,
		rememberTerminalEngine
	} from '$lib/terminalEnginePreference.svelte';

	interface TerminalSessionState extends TerminalSession {
		command?: string;
		cwd?: string;
	}
	interface Props {
		open: boolean;
		sessions: TerminalSessionState[];
		activeId: string | null;
		workspaceRoot: string;
		onToggle: () => void;
		onAddSession: (session: TerminalSessionState) => void;
		onCloseSession: (id: string) => Promise<void>;
		onSetActive: (id: string) => void;
	}
	let {
		open,
		sessions,
		activeId,
		workspaceRoot,
		onToggle,
		onAddSession,
		onCloseSession,
		onSetActive
	}: Props = $props();
	// Brain command tabs come from the page's Brain access state, not from `sessions`.
	const brain = useBrainAccess();
	const brainTabs = $derived(brain?.tabs ?? []);

	interface BrainGroup {
		grantId: string;
		containerName: string;
		/** Shells first, in start order, then one-off commands */
		executions: BrainExecutionView[];
	}
	/**
	 * One drawer tab per granted container. Its shells and commands share the tab, and a
	 * vertical list selects between them. `activeId` still names one execution's tab, so the
	 * page's tab handling is unchanged.
	 */
	const brainGroups = $derived.by(() => {
		const groups: BrainGroup[] = [];
		for (const execution of brainTabs) {
			let group = groups.find((candidate) => candidate.grantId === execution.grantId);
			if (!group) {
				group = {
					grantId: execution.grantId,
					containerName: execution.containerName,
					executions: []
				};
				groups.push(group);
			}
			group.executions.push(execution);
		}
		for (const group of groups)
			group.executions.sort((a, b) => Number(b.kind === 'shell') - Number(a.kind === 'shell'));
		return groups;
	});
	const activeExecutionId = $derived(brainExecutionIdOf(activeId));
	/**
	 * Last selection in each Brain tab, so returning to a tab shows the same shell. Only click
	 * handlers read it; the effect below only writes it.
	 */
	const lastSelected = new SvelteMap<string, string>();
	$effect(() => {
		const id = activeExecutionId;
		const execution = id ? brainTabs.find((candidate) => candidate.id === id) : undefined;
		if (execution) lastSelected.set(execution.grantId, execution.id);
	});

	/** Engine per shell tab. A tab keeps its engine until the operator switches it. */
	const engines = new SvelteMap<string, TerminalEngineId>();
	/** Core and renderer that each shell tab's viewer actually initialized. */
	const identities = new SvelteMap<string, TerminalViewIdentity>();
	/** The active tab when it is a shell tab. Brain tabs have no engine switcher. */
	const activeShell = $derived(sessions.find((session) => session.id === activeId));

	/** Use the pinned engine, else the engine for new tabs. */
	function engineFor(id: string): TerminalEngineId {
		return engines.get(id) ?? preferredTerminalEngine();
	}
	/** Replace one tab's viewer in place, and use the same engine for new tabs. */
	function switchEngine(id: string, engine: TerminalEngineId) {
		engines.set(id, engine);
		rememberTerminalEngine(engine);
	}
	/** Track what each viewer reports; a disposed viewer reports undefined. */
	function setIdentity(id: string, identity: TerminalViewIdentity | undefined) {
		if (identity) identities.set(id, identity);
		else identities.delete(id);
	}
	// Pin an engine to each new shell tab, so a later switch elsewhere never remounts it.
	$effect(() => {
		const ids = new Set(sessions.map((session) => session.id));
		untrack(() => {
			const preferred = preferredTerminalEngine();
			for (const id of ids) if (!engines.has(id)) engines.set(id, preferred);
			for (const id of [...engines.keys()])
				if (!ids.has(id)) {
					engines.delete(id);
					identities.delete(id);
				}
		});
	});

	function groupActive(group: BrainGroup): boolean {
		return group.executions.some((execution) => execution.id === activeExecutionId);
	}
	/** The remembered selection, else a running shell, else the newest command. */
	function groupSelection(group: BrainGroup): BrainExecutionView {
		const remembered = group.executions.find(
			(execution) => execution.id === lastSelected.get(group.grantId)
		);
		return (
			remembered ??
			group.executions.find(
				(execution) => execution.kind === 'shell' && isRunningStatus(execution.status)
			) ??
			group.executions[group.executions.length - 1]
		);
	}
	/** Status line of one entry in the shell list. */
	function entryStatus(execution: BrainExecutionView): string {
		if (isRunningStatus(execution.status)) {
			if (execution.controller === 'operator') return 'you have control';
			if (execution.kind !== 'shell') return 'running';
			if (!execution.shell?.ready) return 'starting';
			return execution.shell.busy ? 'busy' : 'idle';
		}
		if (execution.status === 'exited') return `ended · exit ${execution.exitCode ?? '?'}`;
		return execution.status.replace('_', ' ');
	}
	function dotClass(execution: BrainExecutionView): string {
		if (!isRunningStatus(execution.status)) return 'bg-[#4c566a]';
		if (execution.controller === 'operator') return 'bg-[#ebcb8b]';
		if (execution.kind === 'shell' && !execution.shell?.busy) return 'bg-[#a3be8c]';
		return 'animate-pulse bg-[#b48ead]';
	}
	let height = $state(320);
	let maximized = $state(false);
	let dragging = $state(false);
	let closeError = $state('');
	let stopDrag = () => {};
	const closingIds = new SvelteSet<string>();

	function addGenericShell() {
		const id = generateId();
		onAddSession({ id, name: 'Shell', cwd: workspaceRoot });
		onSetActive(id);
		if (!open) onToggle();
	}
	async function closeSession(id: string) {
		if (closingIds.has(id)) return;
		closingIds.add(id);
		closeError = '';
		try {
			await onCloseSession(id);
		} catch {
			closeError = 'Could not stop terminal. Retry when the connection is restored.';
		} finally {
			closingIds.delete(id);
		}
	}
	/** Close a Brain tab only. The command continues; the Brain panel can reopen it. */
	function closeBrainTab(executionId: string) {
		const tabId = brainTabId(executionId);
		const grantId = brainTabs.find((execution) => execution.id === executionId)?.grantId;
		brain?.closeTab(executionId);
		if (activeId !== tabId) return;
		// Stay in the same container's tab when it has another entry.
		const sibling = brainTabs.find(
			(execution) => execution.grantId === grantId && execution.id !== executionId
		);
		const next =
			(sibling && brainTabId(sibling.id)) ??
			sessions[sessions.length - 1]?.id ??
			brainTabs.map((execution) => brainTabId(execution.id)).find((id) => id !== tabId);
		if (next) onSetActive(next);
	}
	/** Close a container's Brain tab. Its shells and commands continue. */
	function closeBrainGroup(group: BrainGroup) {
		const wasActive = groupActive(group);
		for (const execution of group.executions) brain?.closeTab(execution.id);
		if (!wasActive) return;
		const next =
			sessions[sessions.length - 1]?.id ??
			brainTabs
				.filter((execution) => execution.grantId !== group.grantId)
				.map((execution) => brainTabId(execution.id))[0];
		if (next) onSetActive(next);
	}
	function onResizeStart(event: MouseEvent) {
		if (maximized) return;
		event.preventDefault();
		stopDrag();
		dragging = true;
		const startY = event.clientY;
		const startHeight = height;
		const move = (next: MouseEvent) => {
			height = Math.min(
				Math.max(150, startHeight + startY - next.clientY),
				window.innerHeight - 50
			);
		};
		stopDrag = () => {
			dragging = false;
			window.removeEventListener('mousemove', move);
			window.removeEventListener('mouseup', stopDrag);
		};
		window.addEventListener('mousemove', move);
		window.addEventListener('mouseup', stopDrag);
	}
	onDestroy(() => stopDrag());
</script>

<div
	class="fixed right-0 bottom-0 left-0 z-40 flex flex-col border-t border-[#4c566a] bg-[#2e3440] {dragging
		? ''
		: 'transition-all duration-300'}"
	style:height={open ? (maximized ? '100vh' : `${height}px`) : '2.5rem'}
>
	{#if open && !maximized}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="absolute top-0 right-0 left-0 z-50 h-1.5 cursor-ns-resize"
			onmousedown={onResizeStart}
		></div>
	{/if}
	<div
		class="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-[#4c566a] px-2"
		role="tablist"
		aria-label="Terminals"
	>
		{#each sessions as session (session.id)}
			<div
				class="flex shrink-0 items-center rounded-t {activeId === session.id
					? 'bg-[#3b4252] text-[#eceff4]'
					: 'text-[#d8dee9]/60'}"
			>
				<button
					data-terminal-tab={session.id}
					id={`terminal-tab-${session.id}`}
					role="tab"
					aria-selected={activeId === session.id}
					aria-controls={`terminal-pane-${session.id}`}
					class="flex items-center gap-1.5 px-3 py-1 text-xs font-medium"
					onclick={() => {
						onSetActive(session.id);
						if (!open) onToggle();
					}}
					type="button"
				>
					<Terminal size={12} /><span class="max-w-28 truncate">{session.name}</span>
				</button>
				<button
					class="pr-2 text-[#d8dee9]/40 disabled:opacity-50"
					onclick={() => closeSession(session.id)}
					disabled={closingIds.has(session.id)}
					type="button"
					aria-label={`Stop ${session.name}`}><X size={11} /></button
				>
			</div>
		{/each}
		{#each brainGroups as group (group.grantId)}
			{@const groupTabId = `brain-group-${group.grantId}`}
			{@const active = groupActive(group)}
			{@const operator = group.executions.some(
				(execution) => isRunningStatus(execution.status) && execution.controller === 'operator'
			)}
			{@const running = group.executions.some((execution) => isRunningStatus(execution.status))}
			<div
				class="flex shrink-0 items-center rounded-t {active
					? 'bg-[#3b4252] text-[#eceff4]'
					: 'text-[#d8dee9]/60'}"
			>
				<button
					data-terminal-tab={groupTabId}
					id={`terminal-tab-${groupTabId}`}
					role="tab"
					aria-selected={active}
					aria-controls={`terminal-pane-${groupTabId}`}
					title={`Brain in ${group.containerName}`}
					class="flex items-center gap-1.5 px-3 py-1 text-xs font-medium"
					onclick={() => {
						onSetActive(brainTabId(groupSelection(group).id));
						if (!open) onToggle();
					}}
					type="button"
				>
					<BrainCircuit size={12} class="shrink-0 text-[#b48ead]" />
					<span>Brain</span>
					<span class="max-w-32 truncate text-[#d8dee9]/50">{group.containerName}</span>
					{#if group.executions.length > 1}
						<span class="rounded-full bg-[#b48ead]/20 px-1.5 text-[10px] text-[#b48ead]"
							>{group.executions.length}</span
						>
					{/if}
					{#if operator}
						<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-[#ebcb8b]"></span>
						<span class="sr-only">You have control</span>
					{:else if running}
						<span class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#b48ead]"></span>
						<span class="sr-only">Running</span>
					{/if}
				</button>
				<button
					class="pr-2 text-[#d8dee9]/40"
					onclick={() => closeBrainGroup(group)}
					type="button"
					title="Close the tab. Shells and commands continue."
					aria-label={`Close Brain tab for ${group.containerName}`}><X size={11} /></button
				>
			</div>
		{/each}
		<button
			onclick={addGenericShell}
			class="shrink-0 p-1 text-[#d8dee9]/60"
			type="button"
			aria-label="New shell"><Plus size={14} /></button
		>
		<div class="flex-1"></div>
		{#if open && activeShell}
			{@const shellId = activeShell.id}
			<TerminalEngineSwitcher
				value={engineFor(shellId)}
				identity={identities.get(shellId)}
				onSelect={(engine) => switchEngine(shellId, engine)}
			/>
		{/if}
		{#if open}
			<button
				onclick={() => (maximized = !maximized)}
				class="p-1 text-[#d8dee9]/60"
				type="button"
				aria-label={maximized ? 'Restore terminal' : 'Maximize terminal'}
				>{#if maximized}<Minimize2 size={14} />{:else}<Maximize2 size={14} />{/if}</button
			>
		{/if}
		<button
			onclick={onToggle}
			class="p-1 text-[#d8dee9]/60"
			type="button"
			aria-label="Toggle terminal drawer"
			aria-expanded={open}
			>{#if open}<ChevronDown size={16} />{:else}<ChevronUp size={16} />{/if}</button
		>
	</div>
	{#if closeError}<p role="alert" class="text-xs text-[#bf616a]">{closeError}</p>{/if}
	<div class="relative min-h-0 flex-1 overflow-hidden" hidden={!open}>
		{#each sessions as session (session.id)}
			<div
				id={`terminal-pane-${session.id}`}
				data-terminal-pane={session.id}
				role="tabpanel"
				aria-labelledby={`terminal-tab-${session.id}`}
				class="absolute inset-2"
				hidden={!open || activeId !== session.id}
				inert={!open || activeId !== session.id}
			>
				<TerminalTab
					sessionId={session.id}
					name={session.name}
					command={session.command}
					cwd={session.cwd ?? workspaceRoot}
					engine={engineFor(session.id)}
					active={activeId === session.id}
					visible={open && activeId === session.id}
					focusOnActivate={true}
					onExit={() => closeSession(session.id)}
					onIdentity={(identity) => setIdentity(session.id, identity)}
					onUseFallback={() => switchEngine(session.id, 'xterm')}
				/>
			</div>
		{/each}
		{#if brain}
			{#each brainGroups as group (group.grantId)}
				{@const groupTabId = `brain-group-${group.grantId}`}
				{@const active = groupActive(group)}
				<div
					id={`terminal-pane-${groupTabId}`}
					data-terminal-pane={groupTabId}
					role="tabpanel"
					aria-labelledby={`terminal-tab-${groupTabId}`}
					class="absolute inset-2 flex gap-2"
					hidden={!open || !active}
					inert={!open || !active}
				>
					<div class="relative min-w-0 flex-1">
						{#each group.executions as execution (execution.id)}
							{@const tabId = brainTabId(execution.id)}
							<div data-terminal-pane={tabId} class="absolute inset-0" hidden={activeId !== tabId}>
								<BrainTerminalTab {execution} access={brain} visible={open && activeId === tabId} />
							</div>
						{/each}
					</div>
					{#if group.executions.length > 1}
						<div
							class="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-l border-[#4c566a] pl-2"
							role="group"
							aria-label={`Brain shells and commands in ${group.containerName}`}
						>
							{#each group.executions as execution (execution.id)}
								{@const tabId = brainTabId(execution.id)}
								<div
									class="group flex items-center rounded {activeId === tabId
										? 'bg-[#3b4252] text-[#eceff4]'
										: 'text-[#d8dee9]/70 hover:bg-[#3b4252]/60'}"
								>
									<button
										type="button"
										aria-pressed={activeId === tabId}
										data-brain-entry={execution.id}
										title={execution.kind === 'shell'
											? `${execution.shell?.name ?? 'shell'} · ${execution.shell?.cwd ?? ''}`
											: execution.command}
										class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-xs"
										onclick={() => onSetActive(tabId)}
									>
										<Terminal size={12} class="shrink-0 text-[#d8dee9]/50" />
										<span class="min-w-0 flex-1">
											<span class="block truncate {execution.kind === 'shell' ? '' : 'font-mono'}"
												>{execution.kind === 'shell'
													? (execution.shell?.name ?? 'shell')
													: execution.command}</span
											>
											<span class="flex items-center gap-1 text-[10px] text-[#d8dee9]/50">
												<span class="h-1.5 w-1.5 shrink-0 rounded-full {dotClass(execution)}"
												></span>
												{entryStatus(execution)}
											</span>
										</span>
									</button>
									<button
										type="button"
										class="pr-1.5 text-[#d8dee9]/40 opacity-0 group-hover:opacity-100 focus:opacity-100"
										onclick={() => closeBrainTab(execution.id)}
										title="Hide from this list. It continues to run."
										aria-label={`Hide ${execution.command}`}><X size={11} /></button
									>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>
