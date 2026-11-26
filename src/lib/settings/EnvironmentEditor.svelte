<script lang="ts">
	/** Write-only secret values and typed public values; save via the shared lock. */
	import type { SettingsSnapshot } from './types';
	interface Props {
		snapshot: SettingsSnapshot;
		disabled: boolean;
		busy: boolean;
		onsave: (operation: string, extra: Record<string, unknown>) => Promise<void>;
		ondirty: (dirty: boolean) => void;
	}
	let { snapshot, disabled, busy, onsave, ondirty }: Props = $props();
	let updates = $state<Record<string, string>>({});
	let name = $state('');
	let value = $state('');
	const count = $derived(Object.keys(updates).length);
	/** Track local draft edits without storing them in browser persistence. */
	function update(key: string, input: string) {
		if (input === '' && snapshot.environment.some((entry) => entry.name === key && entry.secret))
			delete updates[key];
		else updates = { ...updates, [key]: input };
		ondirty(Object.keys(updates).length > 0 || !!name || !!value);
	}
	/** Add a literal environment entry. Values stay local until explicit save. */
	function add() {
		if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) return;
		update(name, value);
		name = '';
		value = '';
	}
	/** Save only this input file; failed saves keep the draft for correction. */
	async function save() {
		try {
			await onsave('environment', { updates });
			updates = {};
			ondirty(false);
		} catch {
			/* The parent shows the safe error; keep draft input. */
		}
	}
	/** Clear all draft values, including secrets. */
	function discard() {
		updates = {};
		name = '';
		value = '';
		ondirty(false);
	}
</script>

<div class="notice">
	These values currently enter DevHarbour through Docker. Saving needs a DevHarbour recreate, then a
	rebuild of existing devcontainers. OpenCode's in-devcontainer port defaults to 4096.
</div>
{#if !snapshot.environmentEditable}
	<p class="notice">
		No managed environment file is available. Add an env-file path inside the private config
		directory on the host.
	</p>
{:else}
	<div class="panel">
		{#each snapshot.environment as entry (entry.name)}
			<div class="row">
				<label for={'env-' + entry.name}><code>{entry.name}</code><span>Recreate</span></label>
				<input
					id={'env-' + entry.name}
					type={entry.secret ? 'password' : 'text'}
					value={updates[entry.name] ?? entry.value ?? ''}
					placeholder={entry.secret && entry.set ? 'Set (leave blank to keep)' : 'Not set'}
					autocomplete="off"
					spellcheck="false"
					disabled={disabled || busy}
					oninput={(event) => update(entry.name, event.currentTarget.value)}
				/>
				{#if ['OPENCODE_PORT', 'OPENCODE_SKIP_START'].includes(entry.name)}<small
						>dev-bootstrap templates do not forward this yet. Its devcontainer.json must use a
						localEnv reference.</small
					>{/if}
			</div>
		{/each}
		{#each Object.keys(updates).filter((key) => !snapshot.environment.some((e) => e.name === key)) as key (key)}
			<div class="row">
				<label for={'new-' + key}><code>{key}</code><span>New variable</span></label><input
					id={'new-' + key}
					type="password"
					value={updates[key]}
					oninput={(event) => update(key, event.currentTarget.value)}
					disabled={disabled || busy}
					autocomplete="off"
				/>
			</div>
		{/each}
	</div>
	<div class="add">
		<input
			aria-label="New variable name"
			placeholder="VARIABLE_NAME"
			bind:value={name}
			oninput={(event) => ondirty(count > 0 || !!event.currentTarget.value || !!value)}
			disabled={disabled || busy}
		/><input
			type="password"
			aria-label="New variable value"
			placeholder="Value (write-only)"
			bind:value
			oninput={(event) => ondirty(count > 0 || !!event.currentTarget.value || !!name)}
			disabled={disabled || busy}
			autocomplete="off"
		/><button
			type="button"
			onclick={add}
			disabled={disabled || busy || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)}
			>Add variable</button
		>
	</div>
	{#if count}<div class="actions">
			<span>{count} environment change{count === 1 ? '' : 's'}</span><button
				type="button"
				onclick={discard}
				disabled={busy}>Discard</button
			><button type="button" class="primary" disabled={disabled || busy} onclick={save}
				>Save environment</button
			>
		</div>{/if}
{/if}

<style>
	.notice {
		border: 1px solid var(--settings-edge);
		padding: 1rem;
		border-radius: 0.5rem;
		color: var(--settings-dim);
		margin-bottom: 1rem;
		font-size: 0.875rem;
	}
	.panel {
		border: 1px solid var(--settings-edge);
		border-radius: 0.5rem;
		background: var(--settings-surface);
		overflow: hidden;
	}
	.row {
		padding: 1.1rem;
		border-bottom: 1px solid var(--settings-edge);
	}
	.row:last-child {
		border: 0;
	}
	label {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.6rem;
		overflow-wrap: anywhere;
	}
	label span {
		color: var(--settings-warn);
		font-size: 0.75rem;
	}
	input {
		min-width: 0;
		width: 100%;
		min-height: 2.75rem;
		background: var(--settings-bg);
		color: inherit;
		border: 1px solid var(--settings-edge);
		border-radius: 0.4rem;
		padding: 0.5rem 0.7rem;
	}
	small {
		display: block;
		margin-top: 0.5rem;
		color: var(--settings-dim);
	}
	.add,
	.actions {
		margin-top: 1rem;
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
		align-items: center;
	}
	.add input {
		flex: 1 1 10rem;
	}
	button {
		min-height: 2.75rem;
		border: 1px solid var(--settings-edge);
		border-radius: 0.4rem;
		padding: 0.5rem 0.8rem;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.primary {
		background: var(--settings-accent);
		color: var(--settings-on-accent);
	}
	.actions span {
		margin-right: auto;
	}
</style>
