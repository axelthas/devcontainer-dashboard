<script lang="ts">
	/**
	 * Instance controls inside the Sandbox panel: pick the target project, prepare a new instance,
	 * review a drifted plan, remove an instance, and run declared kind actions. The server
	 * revalidates every request; this component sends names and options only, never commands.
	 */
	import { Layers, Loader, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-svelte';
	import { onDestroy } from 'svelte';
	import { errorMessage, latestRequest, requestJson } from '$lib/requests';
	import { composeQuery, type ComposeSelection } from '$lib/composeCommands';
	import { choiceLabel, type KindDescriptor } from '$lib/stackKinds/types';
	import type { ComposeInstanceData, ComposeInstanceRemovalPreview } from '$lib/types';
	import RequestError from './RequestError.svelte';

	interface Props {
		repoPath: string;
		/** The checked selection, including the version tag */
		selection: ComposeSelection;
		projectName: string;
		kind: KindDescriptor;
		/** A Compose run or a stale check blocks every write */
		disabled: boolean;
		/** Selected instance; null means the original sandbox */
		target: ComposeInstanceData | null;
		onChanged: () => void;
	}
	let {
		repoPath,
		selection,
		projectName,
		kind,
		disabled,
		target = $bindable(null),
		onChanged
	}: Props = $props();

	const reads = latestRequest();
	let instances = $state<ComposeInstanceData[]>([]);
	let busy = $state<string | null>(null);
	let message = $state('');
	let warnings = $state<string[]>([]);
	let removal = $state<ComposeInstanceRemovalPreview | null>(null);
	let pendingConfirm = $state<{ action: string; option: string } | null>(null);
	let lastAction = $state<Record<string, { value: string; result: string }>>({});
	let disposed = false;
	onDestroy(() => {
		disposed = true;
		reads.cancel();
	});

	const selectionKey = $derived(
		JSON.stringify([repoPath, selection.files, selection.profiles, selection.envFile])
	);
	const actionValues = $derived(target ? { ...target.actions, ...lastAction } : lastAction);

	/** Body fields that identify the selection for every POST. */
	function selectionFields() {
		return { repoPath, ...selection };
	}

	/** Load instances of this selection; keep the target when it still exists. */
	async function load() {
		try {
			await reads.run(
				(signal) =>
					requestJson<{ instances: ComposeInstanceData[] }>(
						`/api/compose/instances?${composeQuery(repoPath, selection)}`,
						{ signal }
					),
				(value) => {
					instances = value.instances;
					target = target
						? (value.instances.find((item) => item.project === target?.project) ?? null)
						: null;
				}
			);
		} catch (cause) {
			if (!disposed) message = errorMessage(cause);
		}
	}

	$effect(() => {
		void selectionKey;
		void load();
	});

	/** Run one write request; refresh the list and the parent afterwards. */
	async function write<T>(key: string, url: string, body: object): Promise<T | undefined> {
		busy = key;
		message = '';
		try {
			const result = await requestJson<T>(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			await load();
			onChanged();
			return result;
		} catch (cause) {
			if (!disposed) message = errorMessage(cause);
			await load();
			return undefined;
		} finally {
			if (!disposed) busy = null;
		}
	}

	/** Prepare a new instance. Nothing starts. */
	async function create() {
		const result = await write<{ instance: { project: string }; warnings: string[] }>(
			'create',
			'/api/compose/instances',
			{ ...selectionFields(), operation: 'create' }
		);
		if (result) {
			warnings = result.warnings;
			target = instances.find((item) => item.project === result.instance.project) ?? null;
		}
	}

	/** Recompute the plan of the target on its slot after the source changed. */
	async function review() {
		if (!target) return;
		const result = await write<{ warnings: string[] }>('review', '/api/compose/instances', {
			...selectionFields(),
			operation: 'review',
			project: target.project
		});
		if (result) warnings = result.warnings;
	}

	/** Show what removal changes and keeps. */
	async function previewRemoval() {
		if (!target) return;
		busy = 'preview';
		message = '';
		try {
			removal = await requestJson<ComposeInstanceRemovalPreview>(
				`/api/compose/instances/remove?project=${encodeURIComponent(target.project)}`
			);
		} catch (cause) {
			if (!disposed) message = errorMessage(cause);
		} finally {
			if (!disposed) busy = null;
		}
	}

	/** Remove the previewed instance with its token. */
	async function confirmRemoval() {
		if (!removal) return;
		const result = await write<{ released: boolean }>('remove', '/api/compose/instances/remove', {
			project: removal.project,
			token: removal.token
		});
		if (result && !result.released)
			message = 'Docker kept some resources. The instance keeps its slot until removal completes.';
		if (result?.released) target = null;
		removal = null;
	}

	/** Run a declared action; a confirmation option needs a second click. */
	async function runAction(action: string, option: string, confirm: boolean) {
		if (confirm && (pendingConfirm?.action !== action || pendingConfirm.option !== option)) {
			pendingConfirm = { action, option };
			return;
		}
		pendingConfirm = null;
		const result = await write<{ result: string }>(`action:${action}`, '/api/compose/action', {
			...selectionFields(),
			...(target ? { instance: target.project } : {}),
			action,
			option,
			confirmed: confirm
		});
		if (result) lastAction = { ...lastAction, [action]: { value: option, result: result.result } };
	}

	/** Pick the target by project name; empty means the original sandbox. */
	function selectTarget(project: string) {
		target = instances.find((item) => item.project === project) ?? null;
		removal = null;
		pendingConfirm = null;
		lastAction = {};
	}
</script>

<div class="mt-3 flex flex-col gap-2 text-xs" aria-label="Compose target">
	<div class="flex flex-wrap items-center gap-2">
		<Layers size={12} class="text-[#5e81ac] dark:text-[#88c0d0]" />
		<label class="font-semibold text-[#4c566a] dark:text-[#d8dee9]/70" for={`target-${projectName}`}
			>Target</label
		>
		<select
			id={`target-${projectName}`}
			value={target?.project ?? ''}
			onchange={(event) => selectTarget(event.currentTarget.value)}
			class="rounded border border-[#d8dee9] bg-white py-0.5 pr-7 pl-2 text-xs text-[#2e3440] dark:border-[#4c566a] dark:bg-[#2e3440] dark:text-[#d8dee9]"
		>
			<option value="">Original sandbox · {projectName}</option>
			{#each instances as item (item.project)}
				<option value={item.project}>{item.project} · slot {item.slot} · {item.state}</option>
			{/each}
		</select>
		<button
			type="button"
			onclick={() => void create()}
			disabled={disabled || busy !== null}
			title="Reserve a slot and prepare another copy of this selection. Nothing starts."
			class="flex items-center gap-1 rounded-lg border border-[#d8dee9] bg-white px-2.5 py-1 font-medium text-[#5e81ac] hover:bg-[#e5e9f0] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#4c566a] dark:bg-[#2e3440] dark:text-[#88c0d0] dark:hover:bg-[#434c5e]"
		>
			{#if busy === 'create'}<Loader size={12} class="animate-spin" />{:else}<Plus size={12} />{/if}
			New instance
		</button>
		<span
			class="rounded-full border border-[#b48ead]/30 bg-[#b48ead]/10 px-2 py-0.5 font-medium text-[#b48ead]"
			title={`Kind from ${kind.source}`}>{kind.title ?? kind.kind}</span
		>
		{#if target}
			<span class="text-[#4c566a] dark:text-[#d8dee9]/60"
				>{target.subnets.join(', ') || 'Docker-assigned subnets'}</span
			>
			{#if target.state !== 'ready'}
				<button
					type="button"
					onclick={() => void review()}
					disabled={disabled || busy !== null || target.state === 'removing'}
					class="flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-[#d08770] hover:bg-[#d08770]/10 disabled:opacity-50"
				>
					<RefreshCw size={12} class={busy === 'review' ? 'animate-spin' : ''} />
					Review plan
				</button>
			{/if}
			<button
				type="button"
				onclick={() => void previewRemoval()}
				disabled={disabled || busy !== null}
				class="ml-auto flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-[#bf616a] hover:bg-[#bf616a]/10 disabled:opacity-50"
			>
				<Trash2 size={12} />
				Remove instance
			</button>
		{/if}
	</div>

	{#if removal}
		<div
			role="alertdialog"
			aria-label={`Remove ${removal.project}`}
			class="rounded-lg border border-[#bf616a]/30 bg-[#bf616a]/5 px-3 py-2 text-[#2e3440] dark:text-[#d8dee9]"
		>
			<p class="font-semibold">Remove {removal.project}?</p>
			<p>
				Removes {removal.containers.length}
				{removal.containers.length === 1 ? 'container' : 'containers'}, {removal.networks.filter(
					(network) => network.attached.length === 0
				).length}
				networks and the instance files. Keeps {removal.volumes.length}
				{removal.volumes.length === 1 ? 'volume' : 'volumes'}, images and source files.
			</p>
			<div class="mt-2 flex gap-2">
				<button
					type="button"
					onclick={() => void confirmRemoval()}
					disabled={busy !== null}
					class="rounded-lg bg-[#bf616a] px-2.5 py-1 font-medium text-white disabled:opacity-50"
					>Remove</button
				>
				<button
					type="button"
					onclick={() => (removal = null)}
					class="rounded-lg px-2.5 py-1 font-medium">Cancel</button
				>
			</div>
		</div>
	{/if}

	{#each kind.actions ?? [] as action (action.id)}
		<div class="flex flex-wrap items-center gap-1.5" role="group" aria-label={action.label}>
			<span class="font-semibold text-[#4c566a] dark:text-[#d8dee9]/70">{action.label}</span>
			{#each action.options as option (option)}
				{@const confirm = action.confirm.includes(option)}
				<button
					type="button"
					aria-label={pendingConfirm?.action === action.id && pendingConfirm.option === option
						? `Confirm ${choiceLabel(action, option)}`
						: choiceLabel(action, option)}
					onclick={() => void runAction(action.id, option, confirm)}
					disabled={disabled ||
						busy !== null ||
						target?.state === 'removing' ||
						(target !== null && target.state !== 'ready')}
					class="rounded-lg border border-[#d8dee9] px-2 py-0.5 font-medium text-[#2e3440] disabled:opacity-50 dark:border-[#4c566a] dark:text-[#d8dee9]"
				>
					{pendingConfirm?.action === action.id && pendingConfirm.option === option
						? `Confirm ${choiceLabel(action, option)}`
						: choiceLabel(action, option)}
				</button>
			{/each}
			{#if actionValues[action.id]}
				<span class="text-[#4c566a] dark:text-[#d8dee9]/60"
					>Last request: {actionValues[action.id].result}</span
				>
			{/if}
		</div>
	{/each}

	{#each warnings as warning, index (index)}
		<p class="flex items-start gap-1.5 text-[#d08770]">
			<TriangleAlert size={12} class="mt-0.5 shrink-0" />
			<span>{warning}</span>
		</p>
	{/each}
	<RequestError {message} />
</div>
