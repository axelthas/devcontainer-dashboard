<script lang="ts">
	/** Review an exact candidate before the independent worker may replace anything. */
	import { resolve } from '$app/paths';
	import { RotateCw } from 'lucide-svelte';
	import type { ApplyReview, ManagedConfig, SettingsSnapshot } from './types';
	interface Props {
		snapshot: SettingsSnapshot;
		candidate?: ManagedConfig;
		label?: string;
		disabled?: boolean;
		onqueued?: () => void;
	}
	let {
		snapshot,
		candidate,
		label = 'Review and recreate',
		disabled = false,
		onqueued
	}: Props = $props();
	let modal = $state<HTMLDialogElement>();
	let review = $state<ApplyReview | null>(null);
	let busy = $state(false);
	let error = $state('');
	let exposure = $state(false);
	let queued = $state(false);
	/** Keep token/revision validation and secret handling on the server. */
	async function post(body: Record<string, unknown>) {
		const response = await fetch(resolve('/api/settings/apply'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		const value = await response.json();
		if (!response.ok)
			throw new Error(
				value.message || 'Apply is unavailable. Check your login and host configuration.'
			);
		return value;
	}
	async function begin() {
		busy = true;
		error = '';
		exposure = false;
		review = null;
		modal?.showModal();
		try {
			review = await post({
				operation: 'apply-review',
				revision: snapshot.revision,
				config: candidate ?? snapshot.config
			});
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Review failed.';
		} finally {
			busy = false;
		}
	}
	async function queue() {
		if (!review) return;
		busy = true;
		error = '';
		try {
			await post({
				operation: 'apply-queue',
				token: review.token,
				confirmRecreate: true,
				allowExposure: exposure
			});
			queued = true;
			modal?.close();
			onqueued?.();
		} catch (cause) {
			error =
				cause instanceof Error
					? cause.message
					: 'Request interrupted. Check the apply banner before retrying.';
		} finally {
			busy = false;
		}
	}
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- apply links can point to a new configured origin; login href already uses resolve -->

<button type="button" class="apply-trigger" disabled={disabled || busy || queued} onclick={begin}
	><RotateCw size={16} />{queued ? 'Recreate queued' : label}</button
>
<dialog
	bind:this={modal}
	oncancel={(event) => {
		if (busy) event.preventDefault();
	}}
>
	<h2>Review and recreate DevHarbour</h2>
	{#if busy && !review}<p role="status">Validating configuration and the owned container…</p>{/if}
	{#if review}
		<p>
			This saves the reviewed configuration, prepares its image, then replaces only this DevHarbour
			instance.
		</p>
		<ul class="changes">
			{#each review.changes as item (item.key)}<li>
					<strong>{item.key}</strong><code
						>{JSON.stringify(item.before) ?? 'Unset'} → {JSON.stringify(item.after) ??
							'Default / unset'}</code
					>
				</li>{/each}
		</ul>
		<div class="warning">
			<strong>Replacement ends login sessions and DevHarbour-owned terminals.</strong>
			<p>
				The container writable layer is lost. Retained volumes stay. Other devcontainers are not
				recreated.
			</p>
		</div>
		{#if review.targetUrl !== review.previousUrl}<p class="address">
				New address: <a href={review.targetUrl} target="_blank" rel="noopener noreferrer"
					>{review.targetUrl}</a
				>. Keep this address and sign in after replacement.
			</p>{/if}
		{#if review.requiresExposure}<label class="approval"
				><input type="checkbox" bind:checked={exposure} /> I approve these remote-access and host-network
				changes. The shared password grants full operator access.</label
			>{/if}
	{/if}
	{#if error}<p role="alert" class="warning">{error}</p>{/if}
	<div class="actions">
		<button type="button" disabled={busy} onclick={() => modal?.close()}>Cancel</button><button
			type="button"
			class="apply-trigger"
			disabled={!review || busy || (review.requiresExposure && !exposure)}
			onclick={queue}>{busy ? 'Starting worker…' : 'Save and recreate'}</button
		>
	</div>
</dialog>

<!-- eslint-enable svelte/no-navigation-without-resolve -->
<style>
	.apply-trigger {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		background: #88c0d0;
		color: #2e3440;
		border: 1px solid #88c0d0;
		border-radius: 0.5rem;
		padding: 0.55rem 0.8rem;
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	button:focus-visible,
	a:focus-visible,
	input:focus-visible {
		outline: 2px solid #88c0d0;
		outline-offset: 3px;
	}
	dialog {
		background: #eceff4;
		color: #2e3440;
		border: 1px solid #4c566a;
		border-radius: 0.8rem;
		width: min(44rem, calc(100vw - 2rem));
		max-height: 85dvh;
		overflow: auto;
		margin: auto;
		padding: 1.5rem;
	}
	:global(.dark) dialog {
		background: #2e3440;
		color: #eceff4;
	}
	dialog::backdrop {
		background: #2e3440aa;
	}
	h2 {
		font-size: 1.25rem;
		font-weight: 650;
		margin-bottom: 0.75rem;
	}
	p {
		margin: 0.5rem 0;
		font-size: 0.9rem;
	}
	.changes {
		max-height: 30dvh;
		overflow: auto;
		border: 1px solid #4c566a;
		border-radius: 0.5rem;
		margin: 1rem 0;
		padding: 0.75rem;
	}
	li {
		margin-bottom: 0.75rem;
		font-size: 0.9rem;
	}
	code {
		display: block;
		overflow-wrap: anywhere;
		font-size: 0.8rem;
		margin-top: 0.3rem;
	}
	.warning,
	.approval {
		display: block;
		padding: 0.8rem;
		border: 1px solid #d08770;
		border-radius: 0.5rem;
		margin: 0.75rem 0;
		font-size: 0.875rem;
	}
	.address {
		overflow-wrap: anywhere;
	}
	a {
		text-decoration: underline;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}
	.actions > button:not(.apply-trigger) {
		border: 1px solid #4c566a;
		border-radius: 0.5rem;
		padding: 0.5rem 0.8rem;
	}
</style>
