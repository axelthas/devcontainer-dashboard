<script lang="ts">
	import { Monitor, Code, Activity, Terminal, Database, Globe, Server } from 'lucide-svelte';

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type LucideIcon = new (...args: any[]) => any;

	interface PortConfig {
		label: string;
		icon: LucideIcon;
		colorClass: string;
	}

	interface Props {
		containerPort: string;
		hostPort: string;
		running: boolean;
		variant?: 'card' | 'row';
	}

	let { containerPort, hostPort, running, variant = 'card' }: Props = $props();

	const PORT_MAP: Record<string, PortConfig> = {
		'6904': {
			label: 'NoVNC',
			icon: Monitor,
			colorClass:
				'text-[#5e81ac] bg-[#81a1c1]/20 border-[#81a1c1]/30 hover:bg-[#81a1c1]/30 dark:text-[#88c0d0] dark:bg-[#81a1c1]/20 dark:border-[#81a1c1]/30 dark:hover:bg-[#81a1c1]/40'
		},
		'4096': {
			label: 'OpenCode',
			icon: Code,
			colorClass:
				'text-[#b48ead] bg-[#b48ead]/20 border-[#b48ead]/30 hover:bg-[#b48ead]/30 dark:text-[#b48ead] dark:bg-[#b48ead]/20 dark:border-[#b48ead]/30 dark:hover:bg-[#b48ead]/40'
		},
		'9001': {
			label: 'Supervisor',
			icon: Activity,
			colorClass:
				'text-[#d08770] bg-[#d08770]/20 border-[#d08770]/30 hover:bg-[#d08770]/30 dark:text-[#d08770] dark:bg-[#d08770]/20 dark:border-[#d08770]/30 dark:hover:bg-[#d08770]/40'
		},
		'8000': {
			label: 'VSCode',
			icon: Terminal,
			colorClass:
				'text-[#5e81ac] bg-[#88c0d0]/30 border-[#88c0d0]/50 hover:bg-[#88c0d0]/50 dark:text-[#88c0d0] dark:bg-[#88c0d0]/20 dark:border-[#88c0d0]/30 dark:hover:bg-[#88c0d0]/30'
		},
		'5432': {
			label: 'PostgreSQL',
			icon: Database,
			colorClass:
				'text-[#5e81ac] bg-[#5e81ac]/10 border-[#5e81ac]/20 hover:bg-[#5e81ac]/20 dark:text-[#81a1c1] dark:bg-[#5e81ac]/30 dark:border-[#5e81ac]/40 dark:hover:bg-[#5e81ac]/50'
		},
		'3306': {
			label: 'MySQL',
			icon: Database,
			colorClass:
				'text-[#5e81ac] bg-[#5e81ac]/10 border-[#5e81ac]/20 hover:bg-[#5e81ac]/20 dark:text-[#81a1c1] dark:bg-[#5e81ac]/30 dark:border-[#5e81ac]/40 dark:hover:bg-[#5e81ac]/50'
		},
		'6379': {
			label: 'Redis',
			icon: Database,
			colorClass:
				'text-[#bf616a] bg-[#bf616a]/10 border-[#bf616a]/20 hover:bg-[#bf616a]/20 dark:text-[#bf616a] dark:bg-[#bf616a]/20 dark:border-[#bf616a]/30 dark:hover:bg-[#bf616a]/30'
		},
		'80': {
			label: 'HTTP Web',
			icon: Globe,
			colorClass:
				'text-[#8fbcbb] bg-[#8fbcbb]/20 border-[#8fbcbb]/30 hover:bg-[#8fbcbb]/30 dark:text-[#8fbcbb] dark:bg-[#8fbcbb]/20 dark:border-[#8fbcbb]/30 dark:hover:bg-[#8fbcbb]/30'
		},
		'443': {
			label: 'HTTPS Web',
			icon: Globe,
			colorClass:
				'text-[#8fbcbb] bg-[#8fbcbb]/20 border-[#8fbcbb]/30 hover:bg-[#8fbcbb]/30 dark:text-[#8fbcbb] dark:bg-[#8fbcbb]/20 dark:border-[#8fbcbb]/30 dark:hover:bg-[#8fbcbb]/30'
		},
		'8080': {
			label: 'Web Alt',
			icon: Globe,
			colorClass:
				'text-[#8fbcbb] bg-[#8fbcbb]/20 border-[#8fbcbb]/30 hover:bg-[#8fbcbb]/30 dark:text-[#8fbcbb] dark:bg-[#8fbcbb]/20 dark:border-[#8fbcbb]/30 dark:hover:bg-[#8fbcbb]/30'
		}
	};

	const fallbackColorClass =
		'text-[#4c566a] bg-[#e5e9f0] border-[#d8dee9] hover:bg-[#d8dee9] dark:text-[#d8dee9] dark:bg-[#434c5e] dark:border-[#4c566a] dark:hover:bg-[#4c566a]';
	const disabledClass =
		'bg-[#eceff4] dark:bg-[#434c5e]/30 text-[#4c566a] dark:text-[#4c566a] border-[#d8dee9] dark:border-[#434c5e] cursor-not-allowed opacity-70';

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
		onclick={() => {
			if (running) window.open(`http://localhost:${hostPort}`, '_blank');
		}}
	>
		<IconComponent size={20} class="shrink-0" />
		<div class="overflow-hidden">
			<span class="block text-sm font-bold truncate">{label}</span>
			<span class="block text-[10px] uppercase tracking-wide opacity-80">:{hostPort}</span>
		</div>
	</button>
{:else}
	<button
		class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all
			{running ? `${colorClass} active:scale-95 cursor-pointer` : disabledClass}"
		disabled={!running}
		onclick={() => {
			if (running) window.open(`http://localhost:${hostPort}`, '_blank');
		}}
	>
		<IconComponent size={14} />
		<span>{label}</span>
		<span class="opacity-60 font-mono">:{hostPort}</span>
	</button>
{/if}
