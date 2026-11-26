<script lang="ts">
	/** A typed shared-schema field. Blank means unset, not a hidden default. */
	import type { SettingDefinition, SettingValue } from './types';
	interface Props {
		name: string;
		definition: SettingDefinition;
		value?: SettingValue;
		changed: boolean;
		onchange: (value: SettingValue | undefined) => void;
	}
	let { name, definition, value, changed, onchange }: Props = $props();
	const present = $derived(value !== undefined);
	const input = $derived(value ?? definition.default ?? '');
	/** Preserve numeric types and treat a blank numeric control as unset. */
	function numberChange(event: Event) {
		const target = event.currentTarget as HTMLInputElement;
		onchange(target.value === '' ? undefined : Number(target.value));
	}
</script>

<div class:changed class="field">
	<div class="description">
		<div class="label-row">
			<label for={'setting-' + name}>{definition.title}</label>
			<span class="badge">Recreate</span>
		</div>
		<p>{definition.description}</p>
		<small
			>Default: <code>{definition.default === undefined ? 'None' : String(definition.default)}</code
			></small
		>
	</div>
	<div class="control">
		{#if definition.type === 'boolean'}
			<label class="switch">
				<span>{input === true ? 'On' : 'Off'}</span>
				<input
					id={'setting-' + name}
					type="checkbox"
					checked={input === true}
					onchange={(event) => onchange(event.currentTarget.checked)}
				/>
			</label>
		{:else if definition.type === 'integer'}
			<input
				id={'setting-' + name}
				type="number"
				min={definition.minimum}
				max={definition.maximum}
				value={input as number}
				oninput={numberChange}
			/>
		{:else if definition.type === 'array'}
			<textarea
				id={'setting-' + name}
				rows="3"
				value={Array.isArray(input) ? input.join('\n') : ''}
				oninput={(event) =>
					onchange(event.currentTarget.value.split('\n').filter((line) => line.trim()))}
			></textarea>
			<small>One literal path per line. No shell expansion.</small>
		{:else}
			<input
				id={'setting-' + name}
				type="text"
				value={String(input)}
				autocomplete="off"
				spellcheck="false"
				oninput={(event) => onchange(event.currentTarget.value || undefined)}
			/>
		{/if}
		<div class="field-footer">
			<code>--{name}</code>
			{#if present}<button type="button" onclick={() => onchange(undefined)}
					>Use default / unset</button
				>{:else}<span>Not saved (default applies)</span>{/if}
		</div>
	</div>
</div>

<style>
	.field {
		position: relative;
		display: grid;
		gap: 1rem;
		padding: 1.2rem;
		border-bottom: 1px solid var(--settings-edge);
	}
	.field:last-child {
		border-bottom: 0;
	}
	.changed {
		box-shadow: inset 3px 0 #d08770;
	}
	.label-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	label {
		font-weight: 600;
	}
	.badge {
		border: 1px solid #ebcb8b66;
		border-radius: 1rem;
		padding: 0.12rem 0.5rem;
		font-size: 0.75rem;
		color: var(--settings-warn);
		background: #ebcb8b11;
	}
	p {
		margin: 0.35rem 0;
		color: var(--settings-dim);
		font-size: 0.875rem;
	}
	small {
		font-size: 0.75rem;
		color: var(--settings-dim);
	}
	code {
		font-family: ui-monospace, monospace;
		font-size: 0.75rem;
		overflow-wrap: anywhere;
	}
	.control {
		min-width: 0;
	}
	input:not([type='checkbox']),
	textarea {
		width: 100%;
		min-height: 2.75rem;
		border: 1px solid var(--settings-edge);
		background: var(--settings-bg);
		color: inherit;
		border-radius: 0.4rem;
		padding: 0.5rem 0.65rem;
		font-family: ui-monospace, monospace;
		font-size: 0.875rem;
	}
	input:focus,
	textarea:focus {
		outline: 2px solid var(--settings-accent);
		outline-offset: 2px;
	}
	.switch {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.75rem;
		min-height: 2.75rem;
	}
	input[type='checkbox'] {
		width: 1.3rem;
		height: 1.3rem;
		accent-color: var(--settings-accent);
	}
	.field-footer {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.5rem;
		margin-top: 0.4rem;
		font-size: 0.75rem;
		color: var(--settings-dim);
	}
	button {
		color: var(--settings-accent);
		cursor: pointer;
	}
	@media (min-width: 1000px) {
		.field {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			gap: 2rem;
			align-items: center;
		}
	}
</style>
