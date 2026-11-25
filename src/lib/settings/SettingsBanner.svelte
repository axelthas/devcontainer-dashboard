<script lang="ts">
	/** A persistent banner distinguishes desired configuration from a confirmed deployment. */
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { AlertTriangle, Check, LoaderCircle } from 'lucide-svelte';
	import ApplyControl from './ApplyControl.svelte';
	import type { ApplyOperation, SettingsSnapshot } from './types';
	interface Props {
		initial?: SettingsSnapshot | null;
	}
	let { initial = null }: Props = $props();
	let snapshot = $state<SettingsSnapshot | null>(null);
	let operation = $state<ApplyOperation | null>(null);
	let interrupted = $state(false);
	let login = $state(false);
	let dismissed = $state('');
	const steps = ['queued', 'validate', 'image', 'recreate', 'health', 'succeeded'];
	const pending = $derived((snapshot ?? initial)?.pending ?? false);
	const active = $derived(!!operation && !['succeeded', 'failed'].includes(operation.phase));
	const show = $derived(
		active || interrupted || login || pending || (operation && dismissed !== operation.id)
	);
	/** Do not read the config through its lock while the independent CLI holds it. */
	async function refresh() {
		try {
			const response = await fetch(resolve('/api/settings/apply'), { cache: 'no-store' });
			if (response.status === 401) {
				login = true;
				return;
			}
			if (!response.ok) throw new Error();
			operation = (await response.json()).operation;
			interrupted = false;
			if (!operation || ['succeeded', 'failed'].includes(operation.phase)) {
				const current = await fetch(resolve('/api/settings'), { cache: 'no-store' });
				if (current.ok) {
					const value = await current.json();
					if (value.available) snapshot = value;
				}
			}
		} catch {
			if (operation && active) interrupted = true;
		}
	}
	onMount(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			await refresh();
			if (!stopped) timer = setTimeout(poll, 2000);
		};
		void poll();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	});
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- apply links can point to a new configured origin; login href already uses resolve -->

{#if show}
	<section
		class="settings-banner"
		aria-label="Configuration status"
		aria-live="polite"
		data-testid="settings-status-banner"
	>
		<div class="summary">
			{#if active}<LoaderCircle
					size={20}
					class="animate-spin"
				/>{:else if operation?.phase === 'succeeded' && !snapshot?.pending}<Check
					size={20}
				/>{:else}<AlertTriangle size={20} />{/if}
			<div>
				<strong
					>{login
						? 'DevHarbour is responding. Sign in to confirm the result.'
						: interrupted
							? 'Connection interrupted during recreation'
							: active
								? operation?.message
								: operation?.phase === 'failed'
									? 'Recreation failed. Saved settings are retained.'
									: pending
										? 'Saved changes are waiting to apply'
										: 'DevHarbour is ready'}</strong
				>
				<p>
					{operation?.phase === 'failed'
						? operation.message
						: active
							? 'The independent worker continues if this page disconnects.'
							: pending
								? 'The running container still uses its applied configuration.'
								: 'The worker recorded successful readiness checks.'}
				</p>
			</div>
		</div>
		{#if operation && (active || interrupted)}<ol aria-label="Apply progress">
				{#each steps.slice(1, -1) as step (step)}<li
						class:complete={steps.indexOf(operation.phase) > steps.indexOf(step)}
						class:current={operation.phase === step}
					>
						{step === 'image'
							? 'Prepare image'
							: step === 'recreate'
								? 'Recreate'
								: step === 'health'
									? 'Health check'
									: 'Validate'}
					</li>{/each}
			</ol>{/if}
		<div class="banner-actions">
			{#if login}<a href={`${resolve('/login')}?next=${encodeURIComponent(resolve('/settings'))}`}
					>Sign in again</a
				>{/if}
			{#if operation?.targetUrl && (interrupted || login || operation.phase === 'succeeded')}<a
					href={operation.targetUrl}
					target="_blank"
					rel="noopener noreferrer">Open configured address</a
				>{/if}
			{#if !active && !login && (snapshot ?? initial)?.pending}
				<a href={resolve('/settings')}>Review settings</a>
				{#if snapshot ?? initial}<ApplyControl
						snapshot={(snapshot ?? initial)!}
						onqueued={refresh}
					/>{/if}
			{/if}
			{#if !active && !login && !interrupted && operation && !snapshot?.pending}<button
					type="button"
					onclick={() => {
						dismissed = operation!.id;
					}}>Dismiss</button
				>{/if}
		</div>
		{#if operation?.phase === 'failed'}<p class="recovery">
				No automatic rollback was attempted. Use <code
					>{snapshot?.applyCommand ?? initial?.applyCommand ?? 'devharbour apply'}</code
				>
				and <code>devharbour logs</code> on the host. Inspect the current instance before retrying.
			</p>{/if}
	</section>
{/if}

<!-- eslint-enable svelte/no-navigation-without-resolve -->
<style>
	.settings-banner {
		margin: 1rem 1.5rem;
		padding: 1rem 1.25rem;
		border: 1px solid #d08770;
		border-radius: 0.7rem;
		background: #e5e9f0;
		color: #2e3440;
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem 1.5rem;
		align-items: center;
	}
	:global(.dark) .settings-banner {
		background: #3b4252;
		color: #eceff4;
	}
	.summary {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
		flex: 1 1 22rem;
	}
	strong {
		font-size: 0.925rem;
	}
	p {
		font-size: 0.8rem;
		margin-top: 0.2rem;
	}
	.banner-actions {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		flex-wrap: wrap;
	}
	a {
		font-size: 0.85rem;
		text-decoration: underline;
	}
	ol {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
		width: 100%;
	}
	li {
		font-size: 0.8rem;
		border: 1px solid #4c566a;
		border-radius: 1rem;
		padding: 0.2rem 0.65rem;
	}
	.complete {
		border-color: #a3be8c;
	}
	.current {
		border-color: #88c0d0;
		font-weight: 700;
	}
	.recovery {
		width: 100%;
		overflow-wrap: anywhere;
	}
	button {
		border: 1px solid #4c566a;
		border-radius: 0.4rem;
		padding: 0.35rem 0.65rem;
	}
	@media (max-width: 600px) {
		.settings-banner {
			margin: 0.75rem 1rem;
			padding: 0.8rem;
		}
	}
</style>
