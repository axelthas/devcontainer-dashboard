<script lang="ts">
	import { Download, X } from 'lucide-svelte';
	import type { Terminal } from '@xterm/xterm';
	import { TERMINAL_FONT_FAMILY, TERMINAL_THEME } from '$lib/terminalTheme';

	interface Props {
		logId: string;
		title: string;
		onClose: () => void;
	}

	let { logId, title, onClose }: Props = $props();

	let loadError = $state<string | null>(null);

	const logUrl = $derived(`/api/run-logs/${encodeURIComponent(logId)}`);

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') onClose();
	}

	// The server sends the plain-text log as an attachment, so the page stays open.
	function downloadLog() {
		window.location.assign(`${logUrl}?download`);
	}

	// Renders the kept output read-only, with the colours of the original terminal.
	function logAttachment(node: HTMLDivElement) {
		let destroyed = false;
		let terminal: Terminal | null = null;
		let resizeObserver: ResizeObserver | null = null;
		const url = logUrl;

		async function init() {
			const [{ Terminal: XTerm }, { FitAddon }, res] = await Promise.all([
				import('@xterm/xterm'),
				import('@xterm/addon-fit'),
				fetch(url)
			]);
			if (destroyed) return;
			if (!res.ok) {
				loadError = 'This log is no longer available.';
				return;
			}
			const output = await res.text();
			if (destroyed) return;

			terminal = new XTerm({
				theme: TERMINAL_THEME,
				fontFamily: TERMINAL_FONT_FAMILY,
				fontSize: 12,
				disableStdin: true,
				cursorBlink: false,
				scrollback: 100_000
			});
			const fitAddon = new FitAddon();
			terminal.loadAddon(fitAddon);
			terminal.open(node);
			fitAddon.fit();
			terminal.write(output);

			resizeObserver = new ResizeObserver(() => fitAddon.fit());
			resizeObserver.observe(node);
		}

		init();

		return () => {
			destroyed = true;
			resizeObserver?.disconnect();
			terminal?.dispose();
		};
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Backdrop -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
	role="dialog"
	aria-modal="true"
	aria-label={title}
>
	<div
		class="mx-4 w-full max-w-5xl rounded-2xl border border-[#4c566a] bg-[#3b4252] p-6 shadow-2xl"
	>
		<div class="mb-5 flex items-center justify-between">
			<h2 class="text-lg font-bold text-[#eceff4]">{title}</h2>
			<button
				onclick={onClose}
				class="rounded-lg p-1.5 text-[#d8dee9]/60 transition-colors hover:bg-[#4c566a] hover:text-[#eceff4]"
				type="button"
				aria-label="Close"
			>
				<X size={18} />
			</button>
		</div>

		{#if loadError}
			<p class="mb-5 text-sm text-[#bf616a]">{loadError}</p>
		{:else}
			<div
				class="mb-5 h-[32rem] overflow-hidden rounded-lg border border-[#4c566a] bg-[#2e3440] p-2"
			>
				<div {@attach logAttachment} class="h-full w-full"></div>
			</div>
		{/if}

		<div class="flex items-center justify-end">
			<button
				onclick={downloadLog}
				class="flex items-center gap-2 rounded-xl bg-[#4c566a] px-5 py-2.5 text-sm font-semibold text-[#eceff4] transition-colors hover:bg-[#5e6c7e]"
				type="button"
			>
				<Download size={16} />
				Download
			</button>
		</div>
	</div>
</div>
