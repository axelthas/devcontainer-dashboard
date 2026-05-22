<script lang="ts">
	import { Server } from 'lucide-svelte';
	import { PORT_MAP, fallbackColorClass, disabledClass } from '$lib/portConfig';

	interface Props {
		containerPort: string;
		hostPort: string;
		hostname: string;
		running: boolean;
		variant?: 'card' | 'row';
		containerName?: string;
		projectName?: string;
		workspacePath?: string;
		allPorts?: Record<string, string>;
	}

	let { containerPort, hostPort, hostname, running, variant = 'card', containerName, projectName, workspacePath, allPorts }: Props = $props();

	function openService() {
		if (!running) return;
		const serviceUrl = `http://${hostname}:${hostPort}`;
		if (containerName || projectName) {
			const params = new URLSearchParams({
				url: serviceUrl,
				label,
				...(projectName ? { project: projectName } : {}),
				...(containerName ? { container: containerName } : {}),
				...(workspacePath ? { path: workspacePath } : {}),
				...(allPorts && Object.keys(allPorts).length > 1
					? { ports: JSON.stringify(allPorts), hostname }
					: {})
			});
			window.open(`/service?${params}`, '_blank');
		} else {
			window.open(serviceUrl, '_blank');
		}
	}

	const config = $derived(PORT_MAP[containerPort]);
	const label = $derived(config?.label ?? `Port ${containerPort}`);
	const IconComponent = $derived(config?.icon ?? Server);
	const colorClass = $derived(config?.colorClass ?? fallbackColorClass);
</script>

{#if variant === 'card'}
	<button
		class="flex items-center gap-2.5 p-3 rounded-xl border transition-all text-left w-full
			{running ? `${colorClass} hover:shadow-sm active:scale-95 cursor-pointer` : disabledClass}"
		disabled={!running}
		onclick={openService}
	>
		<IconComponent size={20} class="shrink-0" />
		<span class="text-sm font-bold truncate">{label}</span>
	</button>
{:else}
	<button
		class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all
			{running ? `${colorClass} active:scale-95 cursor-pointer` : disabledClass}"
		disabled={!running}
		onclick={openService}
	>
		<IconComponent size={14} />
		<span>{label}</span>
	</button>
{/if}
