<script lang="ts">
	import { TerminalSquare, PanelsTopLeft } from 'lucide-svelte';
	import { resolve } from '$app/paths';
	import { generateId } from '$lib';

	let { path, disabled = false }: { path: string; disabled?: boolean } = $props();

	/** Open inside the click handler, before any network operation or asynchronous work. */
	function open(event: MouseEvent, tool: 'opencode' | 'openchamber') {
		event.stopPropagation();
		const query = new URLSearchParams({ path, tool, launch: generateId() });
		window.open(resolve(`/ai?${query}`), '_blank', 'noopener,noreferrer');
	}
</script>

<button
	type="button"
	{disabled}
	onclick={(event) => open(event, 'opencode')}
	onkeydown={(event) => event.stopPropagation()}
	title={`Open OpenCode TUI in ${path}`}
	class="flex items-center gap-1.5 rounded-lg border border-[#81a1c1]/40 bg-[#81a1c1]/10 px-3 py-1.5 text-xs font-semibold text-[#5e81ac] hover:bg-[#81a1c1]/20 disabled:opacity-40 dark:text-[#88c0d0]"
>
	<TerminalSquare size={14} />OpenCode
</button>
<button
	type="button"
	{disabled}
	onclick={(event) => open(event, 'openchamber')}
	onkeydown={(event) => event.stopPropagation()}
	title={`Open OpenChamber in ${path}`}
	class="flex items-center gap-1.5 rounded-lg border border-[#a3be8c]/40 bg-[#a3be8c]/10 px-3 py-1.5 text-xs font-semibold text-[#4c566a] hover:bg-[#a3be8c]/20 disabled:opacity-40 dark:text-[#a3be8c]"
>
	<PanelsTopLeft size={14} />OpenChamber
</button>
