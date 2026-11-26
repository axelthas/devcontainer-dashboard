<script lang="ts">
	/**
	 * Git ref menu of one repository row. The trigger shows the current branch or tag.
	 * The menu has a search field, Fetch and Pull, and three sections in this order:
	 * local branches, remote branches and tags, each newest first.
	 * A press outside the menu, or Escape, closes it.
	 */
	import {
		ArrowDownToLine,
		Check,
		ChevronDown,
		CloudDownload,
		GitBranch,
		Globe,
		Loader,
		Search,
		Tag
	} from 'lucide-svelte';
	import { tick } from 'svelte';
	import { errorMessage, latestRequest, requestJson } from '$lib/requests';
	import {
		fallbackRefs,
		filterRefs,
		refItems,
		relativeAge,
		summarizeFetch,
		summarizePull,
		type RefItem,
		type RefTarget
	} from '$lib/gitRefs';
	import type { GitRefs, RepoRefsResponse } from '$lib/types';

	interface Props {
		repoPath: string;
		currentBranch?: string;
		currentTag?: string;
		open: boolean;
		/** True while the parent checks out a ref in this repository. */
		checkingOut: boolean;
		onToggle: () => void;
		onClose: () => void;
		onCheckout: (target: RefTarget) => void;
		/** Called after a pull, so that the parent refreshes the repository row. */
		onPulled?: () => Promise<void> | void;
	}

	let {
		repoPath,
		currentBranch,
		currentTag,
		open,
		checkingOut,
		onToggle,
		onClose,
		onCheckout,
		onPulled
	}: Props = $props();

	/** Rows per section. The search finds the rest. */
	const LIMIT = 100;
	const uid = $props.id();

	let refs = $state<GitRefs | null>(null);
	let loading = $state(false);
	let loadError = $state('');
	/** Set when the server fell back to unordered name lists. */
	let fallbackReason = $state('');
	let query = $state('');
	let activeIndex = $state(0);
	let busy = $state<'fetch' | 'pull' | null>(null);
	let notice = $state<{ ok: boolean; text: string } | null>(null);
	let now = $state(Date.now());

	let root = $state<HTMLDivElement>();
	let trigger = $state<HTMLButtonElement>();
	let list = $state<HTMLDivElement>();

	const reads = latestRequest();

	const view = $derived(refs ? filterRefs(refs, query, LIMIT) : null);
	const items = $derived<RefItem[]>(view ? refItems(view) : []);
	const currentLocal = $derived(refs?.local.find((b) => b.name === currentBranch));
	const pullBlocked = $derived.by(() => {
		if (!currentBranch) return 'HEAD is detached. Check out a branch to pull.';
		if (!refs) return 'Reading branches…';
		if (!currentLocal?.upstream) return `${currentBranch} has no upstream branch.`;
		if (currentLocal.upstreamGone) return `${currentLocal.upstream} no longer exists.`;
		return '';
	});
	const lastFetched = $derived(
		refs?.lastFetchedAt ? `Fetched ${relativeAge(refs.lastFetchedAt, now)} ago` : 'Never fetched'
	);

	/** Read the refs. Keep earlier refs on screen while a new read runs. */
	async function load() {
		loading = refs === null;
		loadError = '';
		try {
			await reads.run(
				(signal) =>
					requestJson<RepoRefsResponse>(
						`/api/repos/branches?path=${encodeURIComponent(repoPath)}`,
						{ signal }
					),
				(data) => {
					refs = data.refs ?? fallbackRefs(data);
					fallbackReason = data.refs ? '' : (data.refsError ?? 'Git is not available.');
					now = Date.now();
				}
			);
		} catch (cause) {
			loadError = errorMessage(cause);
		} finally {
			loading = false;
		}
	}

	/** Each opening reads the refs again and starts with an empty search. */
	function toggle() {
		if (open) {
			reads.cancel();
		} else {
			query = '';
			activeIndex = 0;
			if (!busy) notice = null;
			void load();
		}
		onToggle();
	}

	function close() {
		reads.cancel();
		onClose();
	}

	/** Put the cursor in the search field when the menu opens. */
	function focusOnMount(node: HTMLInputElement) {
		node.focus();
	}

	/** Run Fetch or Pull, show a one-line result, then read the refs again. */
	async function runGit(kind: 'fetch' | 'pull') {
		if (busy || checkingOut) return;
		busy = kind;
		notice = null;
		try {
			const data = await requestJson<{ output?: string }>(`/api/repos/${kind}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: repoPath })
			});
			notice = {
				ok: true,
				text: kind === 'fetch' ? summarizeFetch(data.output) : summarizePull(data.output)
			};
			await load();
			if (kind === 'pull') await onPulled?.();
		} catch (cause) {
			notice = { ok: false, text: errorMessage(cause) };
		} finally {
			busy = null;
		}
	}

	function choose(item: RefItem) {
		if (busy || checkingOut) return;
		onCheckout(item.target);
	}

	function isCurrent(item: RefItem): boolean {
		if (item.kind === 'local') return item.ref.name === currentBranch;
		if (item.kind === 'tag') return item.ref.name === currentTag;
		return false;
	}

	/** Keep the highlighted row visible while the arrow keys move it. */
	async function moveActive(step: number) {
		if (items.length === 0) return;
		activeIndex = Math.min(items.length - 1, Math.max(0, activeIndex + step));
		await tick();
		list?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
	}

	function onSearchKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			void moveActive(1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			void moveActive(-1);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const item = items[activeIndex];
			if (item) choose(item);
		}
	}

	/** A press anywhere outside the trigger and the menu closes the menu. */
	function closeOnOutsidePress(event: PointerEvent) {
		if (open && root && !root.contains(event.target as Node)) close();
	}

	function closeOnEscape(event: KeyboardEvent) {
		if (!open || event.key !== 'Escape') return;
		event.preventDefault();
		close();
		trigger?.focus();
	}

	/** Section offsets in keyboard order. */
	const offsets = $derived({
		local: 0,
		remote: view?.local.length ?? 0,
		tags: (view?.local.length ?? 0) + (view?.remote.length ?? 0)
	});
</script>

<svelte:window onpointerdown={closeOnOutsidePress} onkeydown={closeOnEscape} />

{#snippet sectionHeader(title: string, shown: number, total: number)}
	<div
		class="sticky top-0 z-10 flex items-center justify-between border-y border-[#d8dee9] bg-[#eceff4] px-3 py-1 text-[10px] font-semibold tracking-wide text-[#4c566a] uppercase first:border-t-0 dark:border-[#4c566a] dark:bg-[#2e3440] dark:text-[#d8dee9]/60"
	>
		<span>{title}</span>
		<span class="font-normal normal-case">{shown < total ? `${shown} of ${total}` : total}</span>
	</div>
{/snippet}

{#snippet row(item: RefItem, index: number)}
	{@const current = isCurrent(item)}
	{@const active = index === activeIndex}
	<button
		id="{uid}-ref-{index}"
		type="button"
		role="option"
		aria-selected={active}
		tabindex="-1"
		data-active={active}
		disabled={!!busy || checkingOut}
		onclick={() => choose(item)}
		onpointermove={() => (activeIndex = index)}
		title={item.ref.date
			? `${item.ref.name} · ${item.ref.sha} · ${new Date(item.ref.date).toLocaleString()}`
			: item.ref.name}
		class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors disabled:cursor-wait {active
			? 'bg-[#e5e9f0] dark:bg-[#434c5e]'
			: ''} {current
			? item.kind === 'tag'
				? 'font-semibold text-[#a3be8c]'
				: 'font-semibold text-[#5e81ac] dark:text-[#88c0d0]'
			: 'text-[#2e3440] dark:text-[#d8dee9]'}"
	>
		{#if item.kind === 'local'}
			<GitBranch size={12} class="shrink-0 text-[#81a1c1]" />
		{:else if item.kind === 'remote'}
			<Globe size={12} class="shrink-0 text-[#81a1c1]" />
		{:else}
			<Tag size={12} class="shrink-0 text-[#a3be8c]" />
		{/if}
		<span class="min-w-0 flex-1 truncate font-mono">{item.ref.name}</span>
		{#if item.kind === 'local' && item.ref.upstreamGone}
			<span class="shrink-0 rounded bg-[#bf616a]/15 px-1 text-[10px] text-[#bf616a]">gone</span>
		{:else if item.kind === 'local' && (item.ref.ahead || item.ref.behind)}
			<span
				class="shrink-0 font-mono text-[10px] text-[#d08770]"
				title="Commits ahead and behind {item.ref.upstream}"
				>{item.ref.ahead ? `↑${item.ref.ahead}` : ''}{item.ref.behind
					? `↓${item.ref.behind}`
					: ''}</span
			>
		{:else if item.kind === 'remote' && item.ref.name === currentLocal?.upstream}
			<span
				class="shrink-0 rounded bg-[#88c0d0]/20 px-1 text-[10px] text-[#5e81ac] dark:text-[#88c0d0]"
				>upstream</span
			>
		{:else if item.kind === 'remote' && item.ref.hasLocal}
			<span
				class="shrink-0 rounded bg-[#d8dee9] px-1 text-[10px] text-[#4c566a] dark:bg-[#4c566a] dark:text-[#d8dee9]"
				title="A local branch with this name exists. Checkout selects it.">local</span
			>
		{/if}
		<span
			class="w-7 shrink-0 text-right text-[10px] text-[#4c566a] tabular-nums dark:text-[#d8dee9]/50"
			>{relativeAge(item.ref.date, now)}</span
		>
		{#if current}
			<Check size={12} class="shrink-0 text-[#a3be8c]" />
		{:else}
			<span class="w-3 shrink-0"></span>
		{/if}
	</button>
{/snippet}

<div class="relative" bind:this={root}>
	<button
		bind:this={trigger}
		onclick={(e) => {
			e.stopPropagation();
			toggle();
		}}
		class="flex items-center gap-1 rounded bg-[#e5e9f0] px-2 py-0.5 text-xs dark:bg-[#434c5e] {currentTag &&
		!currentBranch
			? 'text-[#a3be8c] dark:text-[#a3be8c]'
			: 'text-[#5e81ac] dark:text-[#88c0d0]'} border border-[#d8dee9] transition-colors hover:bg-[#d8dee9] dark:border-[#4c566a] dark:hover:bg-[#4c566a]"
		type="button"
		aria-haspopup="listbox"
		aria-expanded={open}
		title={currentBranch ?? currentTag}
	>
		{#if checkingOut}
			<Loader size={10} class="animate-spin" />
		{:else if currentTag && !currentBranch}
			<Tag size={10} />
		{/if}
		<span class="max-w-[180px] truncate">{currentBranch ?? currentTag}</span>
		<ChevronDown size={10} />
	</button>

	{#if open}
		<div
			class="absolute top-full left-0 z-30 mt-1 flex w-80 flex-col overflow-hidden rounded-lg border border-[#d8dee9] bg-white shadow-lg dark:border-[#4c566a] dark:bg-[#3b4252]"
		>
			<!-- Search -->
			<label
				class="flex items-center gap-2 border-b border-[#d8dee9] px-3 py-2 dark:border-[#4c566a]"
			>
				<Search size={12} class="shrink-0 text-[#4c566a] dark:text-[#d8dee9]/60" />
				<input
					{@attach focusOnMount}
					bind:value={query}
					oninput={() => (activeIndex = 0)}
					onkeydown={onSearchKeydown}
					type="search"
					role="combobox"
					aria-label="Search branches and tags"
					aria-expanded="true"
					aria-controls="{uid}-refs"
					aria-activedescendant={items[activeIndex] ? `${uid}-ref-${activeIndex}` : undefined}
					placeholder="Search branches and tags"
					autocomplete="off"
					spellcheck="false"
					class="min-w-0 flex-1 bg-transparent text-xs text-[#2e3440] outline-none placeholder:text-[#4c566a]/70 dark:text-[#eceff4] dark:placeholder:text-[#d8dee9]/40"
				/>
			</label>

			<!-- Fetch and Pull -->
			<div
				class="flex items-center gap-1.5 border-b border-[#d8dee9] px-3 py-1.5 dark:border-[#4c566a]"
			>
				<button
					type="button"
					onclick={() => runGit('fetch')}
					disabled={!!busy || checkingOut}
					title="Fetch all remotes and prune deleted remote branches"
					class="flex items-center gap-1 rounded border border-[#d8dee9] px-2 py-0.5 text-xs text-[#2e3440] transition-colors hover:bg-[#e5e9f0] disabled:opacity-50 dark:border-[#4c566a] dark:text-[#d8dee9] dark:hover:bg-[#434c5e]"
				>
					{#if busy === 'fetch'}<Loader size={11} class="animate-spin" />{:else}<CloudDownload
							size={11}
						/>{/if}
					Fetch
				</button>
				<button
					type="button"
					onclick={() => runGit('pull')}
					disabled={!!busy || checkingOut || !!pullBlocked}
					title={pullBlocked ||
						`Fast-forward ${currentBranch} from ${currentLocal?.upstream ?? 'its upstream'}`}
					class="flex items-center gap-1 rounded border border-[#d8dee9] px-2 py-0.5 text-xs text-[#2e3440] transition-colors hover:bg-[#e5e9f0] disabled:opacity-50 dark:border-[#4c566a] dark:text-[#d8dee9] dark:hover:bg-[#434c5e]"
				>
					{#if busy === 'pull'}<Loader size={11} class="animate-spin" />{:else}<ArrowDownToLine
							size={11}
						/>{/if}
					Pull
					{#if currentLocal?.behind}
						<span class="font-mono text-[10px] text-[#d08770]">↓{currentLocal.behind}</span>
					{/if}
				</button>
				<span
					class="ml-auto truncate text-[10px] text-[#4c566a] dark:text-[#d8dee9]/50"
					title={refs?.lastFetchedAt ? new Date(refs.lastFetchedAt).toLocaleString() : undefined}
					>{lastFetched}</span
				>
			</div>
			{#if notice}
				<div
					role="status"
					class="border-b border-[#d8dee9] px-3 py-1.5 text-xs whitespace-pre-wrap dark:border-[#4c566a] {notice.ok
						? 'text-[#4c566a] dark:text-[#a3be8c]'
						: 'text-[#bf616a]'}"
				>
					{notice.text}
				</div>
			{/if}
			{#if fallbackReason}
				<div
					class="border-b border-[#d8dee9] px-3 py-1.5 text-[10px] text-[#d08770] dark:border-[#4c566a]"
					title={fallbackReason}
				>
					Git could not read dates. Names show in alphabetical order.
				</div>
			{/if}

			<!-- Sections -->
			<div
				bind:this={list}
				id="{uid}-refs"
				role="listbox"
				aria-label="Branches and tags"
				class="max-h-80 overflow-y-auto"
			>
				{#if loading}
					<div class="px-3 py-2 text-xs text-[#4c566a] dark:text-[#d8dee9]/60">Loading…</div>
				{:else if loadError}
					<div class="px-3 py-2 text-xs text-[#bf616a]">{loadError}</div>
				{:else if view}
					{#if view.totals.local > 0}
						{@render sectionHeader('Local branches', view.local.length, view.totals.local)}
						{#each view.local as ref, i (ref.name)}
							{@render row(items[offsets.local + i], offsets.local + i)}
						{/each}
					{/if}
					{#if view.totals.remote > 0}
						{@render sectionHeader('Remote branches', view.remote.length, view.totals.remote)}
						{#each view.remote as ref, i (ref.name)}
							{@render row(items[offsets.remote + i], offsets.remote + i)}
						{/each}
					{/if}
					{#if view.totals.tags > 0}
						{@render sectionHeader('Tags', view.tags.length, view.totals.tags)}
						{#each view.tags as ref, i (ref.name)}
							{@render row(items[offsets.tags + i], offsets.tags + i)}
						{/each}
					{/if}
					{#if items.length === 0}
						<div class="px-3 py-2 text-xs text-[#4c566a] italic dark:text-[#d8dee9]/60">
							{query ? `No branch or tag matches "${query}"` : 'No branches or tags found'}
						</div>
					{/if}
				{/if}
			</div>
		</div>
	{/if}
</div>
