<script lang="ts">
	/** Host and settings: the same preferences as the desktop header, plus the desktop switch. */
	import { BrainCircuit, LogOut, Monitor, Moon, Server, Sun } from 'lucide-svelte';
	import { resolve } from '$app/paths';
	import { useBrainAccess } from '$lib/brainAccess.svelte';
	import { useMobileDashboard } from '$lib/mobile/dashboard.svelte';
	import MGroup from './MGroup.svelte';
	import MRow from './MRow.svelte';
	import MSheet from './MSheet.svelte';

	const dashboard = useMobileDashboard();
	const brain = useBrainAccess();
	const grantCount = $derived(brain?.status?.grants.length ?? 0);
	const desktopHref = `${resolve('/interface')}?use=desktop`;
</script>

<MSheet
	open={dashboard.hostSheetOpen}
	title={dashboard.hostname}
	onClose={() => (dashboard.hostSheetOpen = false)}
	testid="host-sheet"
>
	<MGroup title="Host">
		<MRow
			title={dashboard.hostname}
			subtitle={`${dashboard.runningCount} running · ${dashboard.stoppedCount} stopped containers`}
		>
			{#snippet icon()}<Server size={18} />{/snippet}
		</MRow>
	</MGroup>
	<MGroup title="VS Code" footer="Used for VS Code links on your computer.">
		<label class="block px-4 py-3">
			<span class="text-[14px] text-m-dim">SSH host</span>
			<input
				type="text"
				value={dashboard.vscodeSshHost}
				oninput={(event) => dashboard.setSshHost(event.currentTarget.value)}
				placeholder="SSH host"
				autocapitalize="off"
				autocomplete="off"
				spellcheck="false"
				class="mt-1 block min-h-11 w-full rounded-lg border-none bg-m-raised px-3 font-mono text-[16px] text-m-ink focus:ring-2 focus:ring-m-frost"
			/>
		</label>
	</MGroup>
	<MGroup title="Appearance">
		<div class="grid grid-cols-2 gap-1 p-2" role="radiogroup" aria-label="Appearance">
			{#each [{ light: false, label: 'Dark', icon: Moon }, { light: true, label: 'Light', icon: Sun }] as option (option.label)}
				<button
					type="button"
					role="radio"
					aria-checked={dashboard.light === option.light}
					onclick={() => dashboard.setLight(option.light)}
					class="flex min-h-14 flex-col items-center justify-center gap-1 rounded-[10px] text-[14px] {dashboard.light ===
					option.light
						? 'bg-m-frost/20 text-m-frost'
						: 'text-m-dim'}"
				>
					<option.icon size={18} aria-hidden="true" />{option.label}
				</button>
			{/each}
		</div>
	</MGroup>
	{#if brain?.enabled}
		<MGroup title="Brain" footer="Give or revoke access from a container's actions.">
			<MRow
				title="MCP endpoint on"
				subtitle={grantCount === 1 ? '1 active grant' : `${grantCount} active grants`}
				tone="bg-m-brain/15 text-m-brain"
			>
				{#snippet icon()}<BrainCircuit size={18} />{/snippet}
			</MRow>
		</MGroup>
	{/if}
	<MGroup>
		<MRow
			title="Open the desktop dashboard"
			subtitle="Full layout, for a tablet or a large screen"
			href={desktopHref}
			testid="use-desktop"
		>
			{#snippet icon()}<Monitor size={18} />{/snippet}
		</MRow>
		<form method="POST" action={resolve('/logout')}>
			<button
				type="submit"
				class="flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5 text-left text-[17px] text-m-stop"
			>
				<span class="flex size-8 items-center justify-center rounded-[9px] bg-m-stop/15"
					><LogOut size={18} /></span
				>Sign out
			</button>
		</form>
	</MGroup>
</MSheet>
