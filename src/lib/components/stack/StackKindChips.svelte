<script lang="ts">
	/** Header chips of one Docker Services group: kind and instance slot. Generic stacks show none. */
	import type { ContainerData } from '$lib/types';
	import { stackPresentation } from './presenters';
	import type { StackView } from './types';

	let { containers, view: stack = null }: { containers: ContainerData[]; view?: StackView | null } =
		$props();
	const labels = $derived(stackPresentation(containers));
	/** Loaded kind metadata wins over container labels. */
	const view = $derived({
		kind: stack?.kind.kind ?? labels.kind,
		title: stack?.kind.title ?? (labels.presenter.label || labels.kind),
		slot: stack?.instance?.slot ?? labels.slot
	});
</script>

{#if view.kind && view.kind !== 'generic'}
	<span
		class="rounded-full border border-[#b48ead]/30 bg-[#b48ead]/10 px-2 py-0.5 text-xs font-medium text-[#b48ead]"
		title="Kind">{view.title}</span
	>
{/if}
{#if view.slot !== undefined}
	<span
		class="rounded-full border border-[#88c0d0]/30 bg-[#88c0d0]/10 px-2 py-0.5 text-xs font-medium text-[#5e81ac] dark:text-[#88c0d0]"
		title="DevHarbour instance">instance · slot {view.slot}</span
	>
{/if}
