/**
 * Built-in presenter registry for Docker Services groups. A repository configures a presenter
 * through its kind; it never ships presenter code. Unknown ids fall back to `generic`.
 */
import type { ContainerData } from '$lib/types';

export type PresenterId = 'generic' | 'web' | 'database' | 'profile';

export interface StackPresenter {
	id: PresenterId;
	/** Short header label; empty for the generic presenter, which looks as before */
	label: string;
}

const PRESENTERS: Record<PresenterId, StackPresenter> = {
	generic: { id: 'generic', label: '' },
	web: { id: 'web', label: 'web stack' },
	database: { id: 'database', label: 'database stack' },
	profile: { id: 'profile', label: '' }
};

/** The presenter, kind and instance slot of one project, read from its containers' labels. */
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
		presenter: PRESENTERS[first?.composePresenter ?? 'generic'] ?? PRESENTERS.generic,
		...(first?.composeKind ? { kind: first.composeKind } : {}),
		...(slot !== undefined ? { slot } : {})
	};
}
