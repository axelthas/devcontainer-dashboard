<script lang="ts">
	import { Server } from 'lucide-svelte';
	import { PORT_MAP, fallbackColorClass, disabledClass } from '$lib/portConfig';

	interface Props {
		containerPort: string;
		hostPort: string;
		running: boolean;
		variant?: 'card' | 'row';
		containerName?: string;
		projectName?: string;
		workspacePath?: string;
		allPorts?: Record<string, string>;
	}

	let {
		containerPort,
		hostPort,
		running,
		variant = 'card',
		containerName,
		projectName,
		workspacePath,
		allPorts
	}: Props = $props();

	function openService() {
		if (!running) return;
		const serviceHostname = window.location.hostname;
		const serviceUrl = `http://${serviceHostname}:${hostPort}`;
		if (containerName || projectName) {
			const params = new URLSearchParams({
				url: serviceUrl,
				label,
				...(projectName ? { project: projectName } : {}),
				...(containerName ? { container: containerName } : {}),
				...(workspacePath ? { path: workspacePath } : {}),
				...(allPorts && Object.keys(allPorts).length > 1
					? { ports: JSON.stringify(allPorts), hostname: serviceHostname }
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
		class="flex w-full items-center gap-2.5 rounded-xl border p-3 text-left transition-all
			{running ? `${colorClass} cursor-pointer hover:shadow-sm active:scale-95` : disabledClass}"
		disabled={!running}
		onclick={openService}
	>
		<IconComponent size={20} class="shrink-0" />
		<span class="truncate text-sm font-bold">{label}</span>
	</button>
{:else}
	<button
		class="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all
			{running ? `${colorClass} cursor-pointer active:scale-95` : disabledClass}"
		disabled={!running}
		onclick={openService}
	>
		<IconComponent size={14} />
		<span>{label}</span>
	</button>
{/if}
