/**
 * Built-in presenter registry for Docker Services groups. A repository selects and configures a
 * presenter through its kind; it never ships presenter code. Unknown ids fall back to `generic`,
 * which renders the group exactly as before.
 */
import type { ContainerData } from '$lib/types';
import type { PresenterId } from '$lib/stackKinds/types';
import ChoiceActions from './ChoiceActions.svelte';
import AddressPanel from './AddressPanel.svelte';
import EndpointChips from './EndpointChips.svelte';
import type { StackPresenter } from './types';

const PRESENTERS: Record<PresenterId, StackPresenter> = {
	generic: { id: 'generic', label: '', panels: [] },
	web: { id: 'web', label: 'web stack', Row: EndpointChips, panels: [] },
	database: { id: 'database', label: 'database stack', panels: [] },
	profile: {
		id: 'profile',
		label: '',
		Actions: ChoiceActions,
		Row: EndpointChips,
		panels: [AddressPanel]
	}
};

/** Resolve a presenter id; anything unknown is generic. */
export function presenterFor(id: string | undefined): StackPresenter {
	return (
		(id && Object.hasOwn(PRESENTERS, id) ? PRESENTERS[id as PresenterId] : undefined) ??
		PRESENTERS.generic
	);
}

/** Kind, presenter and instance slot from container labels, before the stack view loads. */
export function stackPresentation(containers: ContainerData[]): {
	presenter: StackPresenter;
	kind?: string;
	slot?: number;
} {
	const first = containers.find((item) => item.composePresenter || item.composeKind);
	const slot = containers.find(
		(item) => item.composeInstanceSlot !== undefined
	)?.composeInstanceSlot;
	return {
		presenter: presenterFor(first?.composePresenter),
		...(first?.composeKind ? { kind: first.composeKind } : {}),
		...(slot !== undefined ? { slot } : {})
	};
}
