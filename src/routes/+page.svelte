<script lang="ts">
	import { Sun, Moon, Container } from 'lucide-svelte';
	import { untrack } from 'svelte';
	import type { ContainerData } from '$lib/types';
	import DevcontainerCard from '$lib/components/DevcontainerCard.svelte';
	import SandboxRow from '$lib/components/SandboxRow.svelte';

	interface Props {
		data: { containers: ContainerData[] };
	}

	let { data }: Props = $props();

	// untrack prevents svelte from treating data.containers as a reactive dep;
	// polling handles subsequent updates
	let containers = $state<ContainerData[]>(untrack(() => data.containers));
	let dark = $state(true);

	// Poll every 5 seconds
	$effect(() => {
		const interval = setInterval(async () => {
			await refreshContainers();
		}, 5000);
		return () => clearInterval(interval);
	});

	async function refreshContainers() {
		const res = await fetch('/api/containers');
		if (res.ok) {
			containers = await res.json();
		}
	}

	function sortContainers(list: ContainerData[]) {
		return [...list].sort((a, b) => {
			const aRunning = a.state === 'running' ? 0 : 1;
			const bRunning = b.state === 'running' ? 0 : 1;
			return aRunning - bRunning;
		});
	}

	const devcontainers = $derived(sortContainers(containers.filter((c) => c.isDevcontainer)));
	const sandboxes = $derived(sortContainers(containers.filter((c) => !c.isDevcontainer)));
	const runningCount = $derived(containers.filter((c) => c.state === 'running').length);
	const stoppedCount = $derived(containers.filter((c) => c.state !== 'running').length);
</script>

<div
	class="{dark ? 'dark' : ''} min-h-screen bg-[#eceff4] text-[#2e3440] dark:bg-[#2e3440] dark:text-[#d8dee9]"
>
	<!-- Header -->
	<header class="border-b border-[#d8dee9] px-6 py-4 dark:border-[#3b4252]">
		<div class="mx-auto flex max-w-7xl items-center justify-between">
			<div class="flex items-center gap-3">
				<Container size={28} class="text-[#5e81ac]" />
				<h1 class="text-2xl font-bold text-[#2e3440] dark:text-[#eceff4]">
					Devcontainer Dashboard
				</h1>
			</div>

			<div class="flex items-center gap-6">
				<!-- Quick stats -->
				<div class="flex gap-4 text-sm">
					<span class="flex items-center gap-1.5">
						<span class="h-2 w-2 rounded-full bg-[#a3be8c]"></span>
						<span class="font-medium text-[#a3be8c]">{runningCount} running</span>
					</span>
					<span class="flex items-center gap-1.5">
						<span class="h-2 w-2 rounded-full bg-[#bf616a]"></span>
						<span class="font-medium text-[#bf616a]">{stoppedCount} stopped</span>
					</span>
				</div>

				<!-- Theme toggle -->
				<button
					class="rounded-full p-2 transition-colors hover:bg-[#e5e9f0] dark:hover:bg-[#3b4252]"
					onclick={() => (dark = !dark)}
					title="Toggle theme"
				>
					{#if dark}
						<Sun size={20} class="text-[#ebcb8b]" />
					{:else}
						<Moon size={20} class="text-[#5e81ac]" />
					{/if}
				</button>
			</div>
		</div>
	</header>

	<main class="mx-auto max-w-7xl px-6 py-8">
		<!-- Section 1: Devcontainers -->
		<section class="mb-10">
			<h2 class="mb-4 text-lg font-semibold text-[#5e81ac]">
				Devcontainers
				<span class="ml-2 text-sm font-normal text-[#81a1c1]">({devcontainers.length})</span>
			</h2>

			{#if devcontainers.length === 0}
				<div class="rounded-xl border border-dashed border-[#434c5e] p-12 text-center">
					<p class="text-[#81a1c1]">No devcontainers found with exposed ports.</p>
				</div>
			{:else}
				<div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
					{#each devcontainers as container (container.id)}
						<DevcontainerCard {container} onRefresh={refreshContainers} />
					{/each}
				</div>
			{/if}
		</section>

		<!-- Section 2: Sandbox Services -->
		<section>
			<h2 class="mb-4 text-lg font-semibold text-[#88c0d0]">
				Sandbox Services
				<span class="ml-2 text-sm font-normal text-[#81a1c1]">({sandboxes.length})</span>
			</h2>

			{#if sandboxes.length === 0}
				<div class="rounded-xl border border-dashed border-[#434c5e] p-12 text-center">
					<p class="text-[#81a1c1]">No sandbox services found with exposed ports.</p>
				</div>
			{:else}
				<div class="flex flex-col gap-2">
					{#each sandboxes as container (container.id)}
						<SandboxRow {container} onRefresh={refreshContainers} />
					{/each}
				</div>
			{/if}
		</section>
	</main>
</div>
