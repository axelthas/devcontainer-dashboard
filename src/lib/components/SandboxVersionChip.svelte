<script lang="ts">
	/**
	 * Version chip of one Compose project, derived from its live containers: the sandbox tag
	 * label first, then the tag in each image reference. It replays a short entrance when the
	 * live version changes, for example after Pull and start recreates the containers.
	 */
	import { fly } from 'svelte/transition';
	import {
		sandboxVersion,
		type SandboxVersionKind,
		type VersionContainer
	} from '$lib/imageReference';

	interface Props {
		project: string;
		containers: VersionContainer[];
	}
	let { project, containers }: Props = $props();

	const version = $derived(sandboxVersion(project, containers));

	const TONES: Record<SandboxVersionKind, string> = {
		tag: 'border-[#8fbcbb]/50 bg-[#8fbcbb]/15 text-[#4f8584] dark:text-[#8fbcbb]',
		mixed: 'border-[#d08770]/40 bg-[#ebcb8b]/15 text-[#d08770] dark:text-[#ebcb8b]',
		implicit:
			'border-[#d8dee9] bg-[#e5e9f0] text-[#4c566a] dark:border-[#4c566a] dark:bg-[#434c5e] dark:text-[#d8dee9]/80',
		build:
			'border-[#d8dee9] bg-[#e5e9f0] text-[#4c566a] dark:border-[#4c566a] dark:bg-[#434c5e] dark:text-[#d8dee9]/80',
		unknown:
			'border-[#d8dee9] bg-[#e5e9f0] text-[#4c566a] dark:border-[#4c566a] dark:bg-[#434c5e] dark:text-[#d8dee9]/80'
	};

	/** One line per service, so a mixed project shows which service differs. */
	const title = $derived.by(() => {
		const labelled = version.services
			.filter((item) => item.source !== 'build')
			.every((item) => item.source === 'label');
		const lead = {
			tag: labelled
				? 'Sandbox tag from the DevHarbour label'
				: 'Tag from the container image references',
			mixed: 'Containers run different versions',
			implicit: 'The image references have no tag, so Docker uses latest',
			build: 'Every service is built locally; no registry tag applies',
			unknown: 'Docker reports only image IDs; the tag is unknown'
		}[version.kind];
		const lines = version.services.map((item) => `${item.service || 'container'}: ${item.tag}`);
		return [lead, ...lines].join('\n');
	});
</script>

<span
	class="inline-flex shrink-0 items-center overflow-hidden rounded-full border px-2 py-0.5 font-mono text-xs font-semibold {TONES[
		version.kind
	]}"
	{title}
	aria-label={`Sandbox version: ${version.label}`}
>
	{#key version.label}
		<span in:fly={{ y: 6, duration: 250 }}>{version.label}</span>
	{/key}
</span>
