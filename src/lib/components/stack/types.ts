/**
 * Client presenter contract for one Docker Services project. The shell (`ComposeGroupRow`)
 * owns layout and lifecycle buttons; a presenter fills four slots: Header, Row, Actions and
 * Panels. Presenters are built in; repositories select and configure them through their kind.
 */
import type { Component } from 'svelte';
import type { ComposeInstanceData, ContainerData } from '$lib/types';
import type { ChoiceOutcome, KindDescriptor, PresenterId } from '$lib/stackKinds/types';

/** Response of GET /api/compose/stack. */
export interface StackView {
	project: string;
	kind: KindDescriptor;
	instance?: Omit<ComposeInstanceData, 'overrideFile' | 'actions'>;
	actionState: Record<string, ChoiceOutcome>;
	/** Selection fields that an action request repeats; absent when the source is unknown */
	request?: {
		repoPath: string;
		instance?: string;
		files: string[];
		profiles: string[];
		envFile?: string;
		tag?: string;
	};
}

export interface PresenterProps {
	view: StackView;
	containers: ContainerData[];
	onChanged: () => void;
}

export interface RowProps {
	view: StackView;
	container: ContainerData;
}

export interface StackPresenter {
	id: PresenterId;
	/** Header label; empty when the kind title or id should show */
	label: string;
	Actions?: Component<PresenterProps>;
	Row?: Component<RowProps>;
	panels: Component<PresenterProps>[];
}
