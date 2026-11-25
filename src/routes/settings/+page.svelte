<script lang="ts">
	/** One desired-state editor for the managed host CLI. Saves never deploy. */
	import { untrack, onMount } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { ArrowLeft, Settings, Sun, Moon, Copy, RefreshCw } from 'lucide-svelte';
	import puffin from '$lib/assets/favicon.svg';
	import SettingField from '$lib/settings/SettingField.svelte';
	import EnvironmentEditor from '$lib/settings/EnvironmentEditor.svelte';
	import {
		SECTIONS,
		type ManagedConfig,
		type SettingValue,
		type SettingsResult,
		type SettingsSnapshot
	} from '$lib/settings/types';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	let current = $state<SettingsResult>(untrack(() => data.settings));
	let draft = $state<ManagedConfig | null>(
		untrack(() => (data.settings.available ? structuredClone(data.settings.config) : null))
	);
	let section = $state('access');
	let dark = $state(true);
	let busy = $state(false);
	let error = $state('');
	let message = $state('');
	let password = $state('');
	let repeat = $state('');
	let environmentDirty = $state(false);
	let allowExposure = $state(false);
	let review = $state<HTMLDialogElement>();
	const snapshot = $derived(current.available ? current : null);
	const fields = $derived(Object.entries(snapshot?.schema.properties.settings.properties ?? {}));
	const changes = $derived.by(() => {
		if (!snapshot || !draft) return [];
		const before = snapshot.config;
		const edited = draft;
		const keys = new Set([...Object.keys(before.settings), ...Object.keys(draft.settings)]);
		const result = [...keys].filter(
			(key) => JSON.stringify(before.settings[key]) !== JSON.stringify(edited.settings[key])
		);
		if (before.restartPolicy !== draft.restartPolicy) result.push('restartPolicy');
		if (JSON.stringify(before.source) !== JSON.stringify(draft.source)) result.push('source');
		return result;
	});
	const dirty = $derived(changes.length > 0);
	const accessMode = $derived(
		draft?.settings['tailscale-socket']
			? 'tailscale'
			: ['127.0.0.1', '::1', 'localhost'].includes(
						String(draft?.settings['bind-address'] ?? '127.0.0.1')
				  )
				? 'local'
				: 'custom'
	);
	const mcpEnabled = $derived(
		Boolean(
			draft?.settings.brain ||
			draft?.settings['brain-port'] ||
			draft?.settings['brain-token-file'] ||
			draft?.settings['brain-funnel']
		)
	);
	const anyDirty = $derived(dirty || environmentDirty || !!password || !!repeat);
	const selected = $derived(SECTIONS.find((item) => item.id === section)!);
	const newExposure = $derived(
		changes.some((key) =>
			[
				'bind-address',
				'origin',
				'tailscale-socket',
				'brain-funnel',
				'tailscale-allow-wildcard-bindings'
			].includes(key)
		)
	);
	const json = $derived(draft ? JSON.stringify(draft, null, 2) : '');
	const savedLines = $derived(
		new Set(snapshot ? JSON.stringify(snapshot.config, null, 2).split('\n') : [])
	);

	onMount(() => {
		dark = localStorage.getItem('devcontainer-dashboard-theme') !== 'light';
	});
	beforeNavigate(({ cancel }) => {
		if (anyDirty && !window.confirm('Discard unsaved Settings changes?')) cancel();
	});
	/** Warn for reload/close without persisting sensitive draft input. */
	function leaving(event: BeforeUnloadEvent) {
		if (anyDirty) {
			event.preventDefault();
			event.returnValue = '';
		}
	}
	/** Confirm before unmounting section-local environment or credential drafts. */
	function selectSection(next: string) {
		if (next === section) return;
		if (
			(environmentDirty || password || repeat) &&
			!window.confirm('Discard unsaved environment/password input?')
		)
			return;
		environmentDirty = false;
		password = '';
		repeat = '';
		section = next;
	}
	/** Use the same theme preference as the desktop dashboard. */
	function theme() {
		dark = !dark;
		localStorage.setItem('devcontainer-dashboard-theme', dark ? 'dark' : 'light');
	}
	/** Edit one desired launcher setting; default values remain visibly distinct. */
	function change(name: string, value: SettingValue | undefined) {
		if (!draft) return;
		if (value === undefined) delete draft.settings[name];
		else draft.settings[name] = value;
		if (name === 'brain' && value === false)
			for (const key of ['brain-port', 'brain-token-file', 'brain-funnel', 'brain-funnel-port'])
				delete draft.settings[key];
		if (name === 'brain-funnel' && value === false) delete draft.settings['brain-funnel-port'];
		message = '';
	}
	/** Hide controls that cannot affect the selected access or listener mode. */
	function visible(name: string): boolean {
		if (name === 'bind-address') return accessMode === 'custom';
		if (name === 'origin') return accessMode !== 'local';
		if (name.startsWith('tailscale-')) return accessMode === 'tailscale';
		if (name.startsWith('gateway')) return accessMode === 'custom';
		if (name === 'ai-port') return accessMode !== 'tailscale';
		if (name === 'image') return draft?.source?.mode !== 'build';
		if (name.startsWith('brain-'))
			return (
				mcpEnabled &&
				(!name.startsWith('brain-funnel') || accessMode === 'tailscale') &&
				(name !== 'brain-funnel-port' || Boolean(draft?.settings['brain-funnel']))
			);
		return true;
	}
	/** Change access explicitly and clear settings that no longer apply. */
	function access(mode: string) {
		if (!draft) return;
		for (const name of [
			'gateway',
			'gateway-host',
			'gateway-ports',
			'tailscale-socket',
			'tailscale-ports',
			'tailscale-gateway-port',
			'tailscale-allow-wildcard-bindings',
			'brain-funnel',
			'brain-funnel-port',
			'origin'
		])
			delete draft.settings[name];
		change('bind-address', '127.0.0.1');
		if (mode === 'tailscale') change('tailscale-socket', '/var/run/tailscale/tailscaled.sock');
		if (mode === 'custom') change('bind-address', '0.0.0.0');
	}
	/** Return to saved desired state without modifying the host. */
	function discard() {
		if (snapshot) draft = structuredClone($state.snapshot(snapshot.config));
		error = '';
		message = '';
	}
	/** Send one bounded operation; failed saves preserve local input for correction. */
	async function save(operation: string, extra: Record<string, unknown>): Promise<void> {
		if (!snapshot) return;
		busy = true;
		error = '';
		message = '';
		try {
			const response = await fetch(resolve('/api/settings'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...extra, operation, revision: snapshot.revision })
			});
			if (response.status === 401)
				throw new Error('Your login expired. Sign in again before saving.');
			const result = await response.json();
			if (!response.ok) throw new Error(result.message || 'Settings could not be saved.');
			current = result as SettingsSnapshot;
			draft = structuredClone(result.config);
			password = '';
			repeat = '';
			review?.close();
			message = 'Saved on the host. Run the apply command below to recreate DevHarbour.';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Settings could not be saved.';
			throw cause;
		} finally {
			busy = false;
		}
	}
	/** Review the exact desired settings before writing anything. */
	function reviewSave(event?: SubmitEvent) {
		event?.preventDefault();
		allowExposure = false;
		review?.showModal();
	}
	/** Save reviewed desired JSON, without starting or replacing containers. */
	async function confirmSave() {
		try {
			await save('save', { config: draft, allowExposure });
		} catch {
			/* Keep review open. */
		}
	}
	/** Replace the password through the dedicated write-only operation. */
	async function passwordSave() {
		try {
			await save('password', { password });
		} catch {
			/* Keep input for correction. */
		}
	}
	/** Reload fresh host state without silently discarding any draft. */
	async function reload() {
		if (anyDirty && !window.confirm('Discard draft changes and reload from the host?')) return;
		busy = true;
		try {
			const response = await fetch(resolve('/api/settings'), { cache: 'no-store' });
			if (!response.ok) throw new Error('Could not reload Settings. Check your login.');
			current = await response.json();
			draft = current.available ? structuredClone($state.snapshot(current.config)) : null;
			environmentDirty = false;
			password = '';
			repeat = '';
			error = '';
			message = '';
		} catch {
			error = 'Could not reload Settings. Check your login.';
		} finally {
			busy = false;
		}
	}
	/** Copy only the non-secret host command; never invoke a shell from the browser. */
	async function copy() {
		try {
			await navigator.clipboard.writeText(snapshot?.applyCommand ?? '');
			message = 'Host apply command copied.';
		} catch {
			error = 'Clipboard unavailable. Select and copy the command manually.';
		}
	}
</script>

<svelte:head><title>Settings | DevHarbour</title></svelte:head>
<svelte:window onbeforeunload={leaving} />
<div class:light={!dark} class="settings-app">
	<header>
		<div class="header-inner">
			<img src={puffin} width="34" height="34" alt="" /><strong>DevHarbour</strong><span class="dim"
				>/ Settings</span
			>
			<div class="header-actions">
				<button type="button" onclick={reload} disabled={busy} aria-label="Reload Settings"
					><RefreshCw size={17} /></button
				><button type="button" onclick={theme} aria-label="Toggle theme"
					>{#if dark}<Sun size={17} />{:else}<Moon size={17} />{/if}</button
				><a href={resolve('/')}><ArrowLeft size={16} /> Containers</a>
			</div>
		</div>
	</header>
	<div class="layout">
		<nav aria-label="Settings sections">
			{#each SECTIONS as item (item.id)}<button
					type="button"
					class:active={section === item.id}
					aria-current={section === item.id ? 'page' : undefined}
					onclick={() => selectSection(item.id)}
					>{item.title}{#if fields.some(([key, field]) => field['x-section'] === item.id && changes.includes(key))}<span
							class="dot"
						></span>{/if}</button
				>{/each}
		</nav>
		<main>
			<h1>{selected.title}</h1>
			<p class="lede">{selected.description}</p>
			<div aria-live="polite">
				{#if error}<p class="notice error">{error}</p>{/if}{#if message}<p class="notice success">
						{message}
					</p>{/if}
			</div>
			{#if !current.available}
				<div class="panel unavailable">
					<Settings size={32} />
					<h2>Managed Settings unavailable</h2>
					<p>{current.message}</p>
					<p>
						This page does not create a second config. Reinstall the updated host CLI, then review <code
							>devharbour apply</code
						> to add the private config-directory mount.
					</p>
				</div>
			{:else if snapshot && draft}
				{#if snapshot.pending}<div class="notice pending">
						<strong>Saved configuration is not confirmed applied.</strong>
						<p>Save does not change the running container. Apply on the Docker host:</p>
						<div class="command">
							<code>{snapshot.applyCommand}</code><button
								type="button"
								onclick={copy}
								aria-label="Copy apply command"><Copy size={16} /></button
							>
						</div>
						<small
							>Review the exact replacement there. Sessions and DevHarbour-owned terminals end; the
							writable layer is lost. Retained volumes stay. Log in again after recreation.</small
						>
					</div>{/if}
				{#if section === 'env'}
					<fieldset disabled={busy || environmentDirty}>
						<legend class="sr-only">Environment file paths</legend>
						<div class="panel">
							{#each fields.filter(([, field]) => field['x-section'] === 'env') as [name, definition] (name)}
								<SettingField
									{name}
									{definition}
									value={draft.settings[name]}
									changed={changes.includes(name)}
									onchange={(value) => change(name, value)}
								/>
							{/each}
						</div>
					</fieldset>
					{#if dirty}<p class="notice">
							Save or discard configuration edits before editing environment values.
						</p>{/if}
					{#key snapshot.revision}<EnvironmentEditor
							{snapshot}
							disabled={dirty}
							{busy}
							onsave={save}
							ondirty={(value) => (environmentDirty = value)}
						/>{/key}
				{:else if section === 'file'}
					<div class="panel file-info">
						<p><strong>Host path</strong><code>{snapshot.path}</code></p>
						<p><strong>Instance</strong><code>{draft.instanceName}</code></p>
						<p>
							<strong>File protection</strong><span
								>Directory 0700, files 0600. CLI and UI use the same lock.</span
							>
						</p>
						<p>
							<strong>Last applied</strong><span
								>{snapshot.appliedAt
									? new Date(snapshot.appliedAt * 1000).toLocaleString()
									: 'Not recorded'}</span
							>
						</p>
						<p>
							<strong>Login password</strong><span
								>Write-only, referenced by config.json. No password values are returned.</span
							>
						</p>
					</div>
					<details class="panel commands">
						<summary>Host commands</summary>
						<pre>devharbour start
devharbour stop
devharbour restart
devharbour status
devharbour logs
devharbour open
devharbour apply
devharbour setup</pre>
						<p>
							Restart keeps the current deployment. Apply reviews saved settings and replaces only
							the owned instance when required.
						</p>
					</details>
				{:else}
					<form onsubmit={reviewSave} id="settings-form">
						<fieldset disabled={busy || environmentDirty}>
							<legend class="sr-only">{selected.title} settings</legend>
							<div class="panel fields">
								{#if section === 'access'}
									<div class="special">
										<label for="access-mode">Access <span class="badge">Recreate</span></label>
										<select
											id="access-mode"
											value={accessMode}
											onchange={(event) => access(event.currentTarget.value)}
											><option value="local">This machine only (recommended)</option><option
												value="tailscale">Tailscale HTTPS</option
											><option value="custom">Custom network binding</option></select
										>
										<small
											>Local only binds 127.0.0.1. Tailscale needs a configured host daemon and a
											valid HTTPS origin. Custom access exposes the shared-password login.</small
										>
									</div>
								{/if}

								{#if section === 'general'}
									<div class="special">
										<label for="restart-policy"
											>Restart policy <span class="badge">Recreate</span></label
										><select id="restart-policy" bind:value={draft.restartPolicy}
											>{#each ['always', 'unless-stopped', 'on-failure', 'no'] as policy (policy)}<option
													value={policy}>{policy}</option
												>{/each}</select
										><small
											>Default: always. Even Docker's restart policy is staged until host apply.</small
										>
									</div>
									<div class="special">
										<label for="source-mode">Image source</label><select
											id="source-mode"
											value={draft.source?.mode ?? 'published'}
											onchange={(event) => {
												if (draft)
													draft.source = {
														...draft.source,
														mode: event.currentTarget.value,
														...(event.currentTarget.value === 'build'
															? { ref: draft.source?.ref ?? 'main' }
															: {})
													};
											}}
											><option value="published">Published image</option><option value="build"
												>Build locally on the host</option
											></select
										>{#if draft.source?.mode === 'build'}<label for="source-ref"
												>Source branch, tag or commit</label
											><input id="source-ref" bind:value={draft.source.ref} />{/if}<small
											>Source checkout and revision are resolved by the host CLI.</small
										>
									</div>
								{/if}
								{#each fields.filter(([, field]) => field['x-section'] === section && field['x-web-editable'] !== false) as [name, definition] (name)}
									{#if visible(name)}
										<SettingField
											{name}
											{definition}
											value={draft.settings[name]}
											changed={changes.includes(name)}
											onchange={(value) => change(name, value)}
										/>
									{/if}
								{/each}
							</div>
						</fieldset>
					</form>
					{#if section === 'access'}<div class="panel password">
							<h2>Login password <span class="badge">Recreate</span></h2>
							<p>
								Set. Leave unchanged unless you want to rotate it. Save configuration edits first.
							</p>
							<label for="password">New password</label><input
								id="password"
								type="password"
								autocomplete="new-password"
								bind:value={password}
								disabled={dirty || busy || environmentDirty}
							/><label for="repeat-password">Repeat password</label><input
								id="repeat-password"
								type="password"
								autocomplete="new-password"
								bind:value={repeat}
								disabled={dirty || busy || environmentDirty}
							/><button
								type="button"
								class="primary"
								onclick={passwordSave}
								disabled={dirty ||
									busy ||
									environmentDirty ||
									password.length < 12 ||
									password !== repeat}>Save new password</button
							><small
								>Write-only private file, never JSON. The running login password stays unchanged
								until host apply.</small
							>
						</div>{/if}
				{/if}
				<div class="mobile-preview">
					<details class="panel">
						<summary>Preview config.json</summary>
						<pre>{json}</pre>
					</details>
				</div>
			{/if}
		</main>
		{#if snapshot && draft}<aside>
				<div class="mirror">
					<div class="mirror-heading">
						<span>config.json</span><small>{dirty ? 'Draft' : 'Saved desired state'}</small>
					</div>
					<pre
						aria-label="Configuration preview">{#each json.split('\n') as line, index (index)}<div
								class:line-changed={!savedLines.has(line)}><span class="line-number"
									>{index + 1}</span
								>{line}</div>{/each}</pre>
					<div class="mirror-footer">No secret values · {changes.length} unsaved settings</div>
				</div>
			</aside>{/if}
	</div>
	{#if dirty}<div class="dock">
			<strong>{changes.length} unsaved change{changes.length === 1 ? '' : 's'}</strong><span
				>Recreate after host apply</span
			><button type="button" onclick={discard} disabled={busy}>Discard</button><button
				type="button"
				onclick={() => reviewSave()}
				class="primary"
				disabled={busy || environmentDirty}>Review and save</button
			>
		</div>{/if}
	<dialog
		bind:this={review}
		oncancel={(event) => {
			if (busy) event.preventDefault();
		}}
	>
		<h2>Save {changes.length} setting{changes.length === 1 ? '' : 's'}?</h2>
		<p>This writes desired configuration only. Nothing is restarted.</p>
		<ul>
			{#each changes as key (key)}<li>
					<strong>{key}</strong><code
						>{JSON.stringify(
							key === 'restartPolicy'
								? snapshot?.config.restartPolicy
								: key === 'source'
									? snapshot?.config.source
									: snapshot?.config.settings[key]
						) ?? 'Unset'} → {JSON.stringify(
							key === 'restartPolicy'
								? draft?.restartPolicy
								: key === 'source'
									? draft?.source
									: draft?.settings[key]
						) ?? 'Default / unset'}</code
					>
				</li>{/each}
		</ul>
		{#if newExposure}<label class="approval"
				><input type="checkbox" bind:checked={allowExposure} /> I approve these remote-access / host-network
				settings. The shared password grants full operator access. Public MCP uses its separate bearer
				token.</label
			>{/if}
		{#if error}<p role="alert" class="notice error">{error}</p>{/if}
		<div class="dialog-actions">
			<button type="button" disabled={busy} onclick={() => review?.close()}>Cancel</button><button
				type="button"
				class="primary"
				disabled={busy || (newExposure && !allowExposure)}
				onclick={confirmSave}>{busy ? 'Saving…' : 'Save only'}</button
			>
		</div>
	</dialog>
</div>

<style>
	.settings-app {
		--settings-bg: #2e3440;
		--settings-surface: #3b4252;
		--settings-edge: #4c566a;
		--settings-dim: #d8dee9;
		--settings-accent: #88c0d0;
		--settings-warn: #ebcb8b;
		--settings-on-accent: #2e3440;
		min-height: 100vh;
		background: var(--settings-bg);
		color: #eceff4;
		font:
			1rem/1.5 system-ui,
			sans-serif;
		padding-bottom: 9rem;
	}
	.light {
		--settings-bg: #eceff4;
		--settings-surface: #e5e9f0;
		--settings-edge: #c5ccd8;
		--settings-dim: #4c566a;
		--settings-accent: #5e81ac;
		--settings-warn: #5e81ac;
		--settings-on-accent: #eceff4;
		color: #2e3440;
	}
	header {
		background: var(--settings-surface);
		border-bottom: 1px solid var(--settings-edge);
	}
	.header-inner {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		max-width: 1440px;
		margin: auto;
		padding: 0.85rem 1.5rem;
	}
	.header-actions {
		margin-left: auto;
		display: flex;
		gap: 0.6rem;
		align-items: center;
	}
	a {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: inherit;
	}
	.dim,
	.lede {
		color: var(--settings-dim);
	}
	.layout {
		display: grid;
		gap: 1.5rem;
		max-width: 1440px;
		margin: auto;
		padding: 1.5rem;
	}
	nav {
		display: flex;
		overflow-x: auto;
		gap: 0.3rem;
	}
	nav button {
		white-space: nowrap;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.55rem 0.8rem;
		text-align: left;
		border-color: transparent;
	}
	nav .active {
		background: var(--settings-surface);
		box-shadow: inset 2px 0 var(--settings-accent);
	}
	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 100%;
		background: #d08770;
	}
	main {
		min-width: 0;
	}
	h1 {
		font-size: 1.65rem;
		font-weight: 650;
		letter-spacing: -0.03em;
	}
	h2 {
		font-size: 1.1rem;
		font-weight: 600;
	}
	.lede {
		margin: 0.25rem 0 1.5rem;
	}
	.panel {
		border: 1px solid var(--settings-edge);
		background: var(--settings-surface);
		border-radius: 0.55rem;
		overflow: hidden;
	}
	.unavailable {
		padding: 2rem;
		display: grid;
		gap: 1rem;
	}
	.notice {
		padding: 1rem;
		margin-bottom: 1rem;
		border: 1px solid var(--settings-edge);
		border-radius: 0.5rem;
		font-size: 0.875rem;
	}
	.error {
		border-color: #bf616a;
	}
	.success {
		border-color: #a3be8c;
	}
	.pending {
		border-color: #ebcb8b66;
	}
	.pending p {
		margin: 0.3rem 0;
	}
	.command {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 0.6rem 0;
		padding: 0.6rem;
		background: var(--settings-surface);
		border-radius: 0.4rem;
	}
	.command code {
		flex: 1;
		overflow-wrap: anywhere;
	}
	small {
		font-size: 0.75rem;
		color: var(--settings-dim);
		display: block;
	}
	code,
	pre {
		font-family: ui-monospace, monospace;
		font-size: 0.8rem;
	}
	.special,
	.password {
		padding: 1.2rem;
	}
	.special {
		border-bottom: 1px solid var(--settings-edge);
		display: grid;
		gap: 0.5rem;
	}
	label {
		display: block;
		font-weight: 500;
	}
	.badge {
		color: var(--settings-warn);
		font-size: 0.75rem;
		margin-left: 0.5rem;
	}
	select,
	input:not([type='checkbox']) {
		width: 100%;
		min-height: 2.75rem;
		background: var(--settings-bg);
		color: inherit;
		border: 1px solid var(--settings-edge);
		border-radius: 0.4rem;
		padding: 0.5rem 0.7rem;
	}
	.password {
		margin-top: 1rem;
		display: grid;
		gap: 0.6rem;
	}
	button {
		min-height: 2.4rem;
		border: 1px solid var(--settings-edge);
		padding: 0.45rem 0.75rem;
		border-radius: 0.4rem;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.primary {
		background: var(--settings-accent);
		color: var(--settings-on-accent);
		font-weight: 600;
	}
	button:focus-visible,
	a:focus-visible,
	input:focus-visible,
	select:focus-visible,
	summary:focus-visible {
		outline: 2px solid var(--settings-accent);
		outline-offset: 3px;
	}
	.file-info {
		padding: 1rem;
	}
	.file-info p {
		padding: 0.6rem 0;
		display: grid;
		gap: 0.25rem;
		overflow-wrap: anywhere;
	}
	details {
		padding: 1rem;
		margin-top: 1rem;
	}
	summary {
		cursor: pointer;
	}
	details pre {
		overflow: auto;
		margin-top: 1rem;
	}
	.commands p {
		margin-top: 1rem;
	}
	aside {
		display: none;
		min-width: 0;
	}
	.mirror {
		position: sticky;
		top: 1.5rem;
		border: 1px solid var(--settings-edge);
		border-radius: 0.5rem;
		background: #2e3440;
		color: #eceff4;
		overflow: hidden;
	}
	.mirror-heading,
	.mirror-footer {
		display: flex;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		font-size: 0.8rem;
		border-bottom: 1px solid #4c566a;
	}
	.mirror-heading small {
		color: #d8dee9;
	}
	.mirror pre {
		overflow: auto;
		max-height: 70vh;
		padding: 0.8rem 0;
		line-height: 1.7;
		color: #a3be8c;
	}
	.line-number {
		display: inline-block;
		width: 2.3rem;
		padding-right: 0.7rem;
		text-align: right;
		color: #d8dee9;
		user-select: none;
	}
	.line-changed {
		background: #d0877020;
		box-shadow: inset 2px 0 #d08770;
	}
	.mirror-footer {
		border-top: 1px solid #4c566a;
		border-bottom: 0;
		color: #d8dee9;
	}
	.dock {
		position: fixed;
		bottom: 1rem;
		left: 1rem;
		right: 1rem;
		max-width: 1000px;
		margin: auto;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		padding: 0.8rem 1rem;
		border: 1px solid var(--settings-edge);
		border-radius: 0.7rem;
		background: var(--settings-surface);
		box-shadow: 0 1rem 3rem #2e344066;
	}
	.dock strong {
		margin-right: auto;
	}
	.dock span {
		font-size: 0.8rem;
		color: var(--settings-warn);
	}
	dialog {
		color: inherit;
		background: var(--settings-bg);
		border: 1px solid var(--settings-edge);
		border-radius: 0.7rem;
		padding: 1.5rem;
		width: min(38rem, calc(100vw - 2rem));
		max-height: 85vh;
		overflow-y: auto;
		margin: auto;
	}
	dialog::backdrop {
		background: #2e3440aa;
	}
	dialog ul {
		margin: 1rem 0;
		padding: 0.6rem;
		border: 1px solid var(--settings-edge);
		border-radius: 0.4rem;
		max-height: 35vh;
		overflow-y: auto;
	}
	dialog li {
		margin: 0.7rem 0;
	}
	dialog li code {
		display: block;
		overflow-wrap: anywhere;
		margin-top: 0.2rem;
		color: var(--settings-dim);
	}
	.approval {
		padding: 1rem;
		border: 1px solid #bf616a;
		border-radius: 0.4rem;
		font-size: 0.875rem;
	}
	.dialog-actions {
		margin-top: 1rem;
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	@media (min-width: 760px) {
		.layout {
			grid-template-columns: 180px minmax(0, 1fr);
		}
		nav {
			flex-direction: column;
			overflow: visible;
			align-self: start;
			position: sticky;
			top: 1rem;
		}
	}
	@media (min-width: 1280px) {
		.layout {
			grid-template-columns: 180px minmax(0, 1fr) 370px;
		}
		aside {
			display: block;
		}
		.mobile-preview {
			display: none;
		}
	}
	@media (max-width: 600px) {
		.layout,
		.header-inner {
			padding: 1rem;
		}
		.header-inner .dim,
		.dock span {
			display: none;
		}
		.header-actions {
			gap: 0.25rem;
		}
		.dock {
			left: 0.5rem;
			right: 0.5rem;
			bottom: 0.5rem;
		}
		.dock strong {
			font-size: 0.875rem;
		}
	}
</style>
