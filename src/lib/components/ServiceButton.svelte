<script lang="ts">
	import {
		Monitor,
		Code,
		Activity,
		Terminal,
		Database,
		Globe,
		Server
	} from 'lucide-svelte';

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type LucideIcon = new (...args: any[]) => any;

	interface Props {
		containerPort: string;
		hostPort: string;
		running: boolean;
	}

	let { containerPort, hostPort, running }: Props = $props();

	interface PortMapping {
		label: string;
		icon: LucideIcon;
		colorClass: string;
	}

	const PORT_MAP: Record<string, PortMapping> = {
		'6904': { label: 'NoVNC', icon: Monitor, colorClass: 'bg-[#5e81ac] hover:bg-[#81a1c1]' },
		'4096': { label: 'OpenCode', icon: Code, colorClass: 'bg-[#88c0d0] hover:bg-[#8fbcbb]' },
		'9001': { label: 'Supervisor', icon: Activity, colorClass: 'bg-[#81a1c1] hover:bg-[#88c0d0]' },
		'8000': { label: 'VSCode', icon: Terminal, colorClass: 'bg-[#5e81ac] hover:bg-[#81a1c1]' },
		'5432': { label: 'Database', icon: Database, colorClass: 'bg-[#8fbcbb] hover:bg-[#88c0d0]' },
		'3306': { label: 'Database', icon: Database, colorClass: 'bg-[#8fbcbb] hover:bg-[#88c0d0]' },
		'6379': { label: 'Redis', icon: Database, colorClass: 'bg-[#8fbcbb] hover:bg-[#88c0d0]' },
		'80': { label: 'Web', icon: Globe, colorClass: 'bg-[#81a1c1] hover:bg-[#88c0d0]' },
		'443': { label: 'Web', icon: Globe, colorClass: 'bg-[#81a1c1] hover:bg-[#88c0d0]' },
		'8080': { label: 'Web', icon: Globe, colorClass: 'bg-[#81a1c1] hover:bg-[#88c0d0]' }
	};

	const mapping = $derived(PORT_MAP[containerPort]);
	const label = $derived(mapping?.label ?? `Port ${containerPort}`);
	const IconComponent = $derived(mapping?.icon ?? Server);
	const colorClass = $derived(mapping?.colorClass ?? 'bg-[#4c566a] hover:bg-[#434c5e]');
</script>

<button
	class="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm font-medium text-white transition-colors
		{colorClass}
		{running ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'}"
	disabled={!running}
	onclick={() => {
		if (running) window.open(`http://localhost:${hostPort}`, '_blank');
	}}
>
	<IconComponent size={14} />
	{label}
</button>
