/**
 * Container lifecycle requests shared by the icon toolbar and the devcontainer menus.
 * A rebuild is a server-owned session: disposing a controller stops polling, never the build.
 */
import type { ContainerData } from '$lib/types';

export type ContainerAction = 'start' | 'stop' | 'restart' | 'delete';
export type ContainerActionKind = ContainerAction | 'rebuild';

/** Labels for a row that waits for an action to complete. */
export const TRANSITION_LABELS: Record<ContainerActionKind, string> = {
	start: 'Starting',
	stop: 'Stopping',
	restart: 'Restarting',
	delete: 'Deleting',
	rebuild: 'Rebuilding'
};

export interface ContainerActionOptions {
	id: string;
	onRefresh: () => Promise<void>;
	/** Set only for devcontainers; other Docker services never get a rebuild action. */
	rebuildContainer?: ContainerData;
	onOpenBuild?: (id: string, command: string, name: string, cwd: string) => void;
}

/** Render bounded server messages as text, never HTML, including authentication failures. */
async function responseError(response: Response): Promise<string> {
	const body = await response.json().catch(() => null);
	return typeof body?.message === 'string'
		? body.message.slice(0, 500)
		: `Request failed (${response.status})`;
}

export class ContainerActions {
	loadingAction = $state<ContainerActionKind | null>(null);
	actionError = $state('');
	readonly #options: () => ContainerActionOptions;
	#rebuildSessionId: string | null = null;
	#pollTimer: ReturnType<typeof setTimeout> | undefined;
	#disposed = false;

	/** Read options through a getter, so component props stay reactive. */
	constructor(options: () => ContainerActionOptions) {
		this.#options = options;
	}

	/** True while any action request or rebuild runs. */
	get busy(): boolean {
		return this.loadingAction !== null;
	}

	/** Rebuild needs the exact workspace and configuration labels of the container. */
	get canRebuild(): boolean {
		const container = this.#options().rebuildContainer;
		return Boolean(container?.localWorkspacePath && container?.devcontainerConfigFile);
	}

	/** Stop polling. An accepted rebuild continues on the server. */
	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#pollTimer);
	}

	/** Poll operation identity after the old container has been removed; never create a second job. */
	async #pollRebuild(): Promise<void> {
		if (this.#disposed || !this.#rebuildSessionId) return;
		const { id, onRefresh } = this.#options();
		try {
			const response = await fetch(
				`/api/containers/${id}/rebuild?sessionId=${encodeURIComponent(this.#rebuildSessionId)}`,
				{ cache: 'no-store' }
			);
			if (this.#disposed) return;
			if (!response.ok) {
				const message = await responseError(response);
				if (response.status === 404) {
					this.#rebuildSessionId = null;
					this.loadingAction = null;
					this.actionError = message;
					await onRefresh();
					return;
				}
				throw new Error(message);
			}
			const build = await response.json();
			if (this.#disposed) return;
			if (build.status !== 'running') {
				this.#rebuildSessionId = null;
				this.loadingAction = null;
				this.actionError =
					build.status === 'failed'
						? 'Rebuild failed. Check the build terminal or workspace log.'
						: '';
				await onRefresh();
				return;
			}
			this.actionError = '';
		} catch (cause) {
			if (!this.#disposed) {
				this.actionError = `Build status unavailable. The build may still be running. ${cause instanceof Error ? cause.message : 'Check the build terminal.'}`;
			}
		}
		if (!this.#disposed && this.#rebuildSessionId)
			this.#pollTimer = setTimeout(() => void this.#pollRebuild(), 2000);
	}

	/** Confirm replacement separately from restart; the server resolves all filesystem authority. */
	async rebuild(): Promise<void> {
		const { id, rebuildContainer, onOpenBuild } = this.#options();
		if (!this.canRebuild || this.loadingAction !== null || !rebuildContainer) return;
		if (
			!confirm(
				`Rebuild and restart "${rebuildContainer.projectName}" (${id})?\n\nThis replaces the container, interrupts its services and terminals, and discards changes in its writable layer. Workspace files and volumes are not deleted, but lifecycle scripts can change mounted data. There is no automatic rollback.`
			)
		)
			return;
		this.loadingAction = 'rebuild';
		this.actionError = '';
		try {
			const response = await fetch(`/api/containers/${id}/rebuild`, { method: 'POST' });
			if (!response.ok) throw new Error(await responseError(response));
			const build = await response.json();
			if (this.#disposed) return;
			this.#rebuildSessionId = build.id;
			onOpenBuild?.(build.id, '', `Rebuild ${build.repoName}`, build.repoPath);
			void this.#pollRebuild();
		} catch (cause) {
			if (this.#disposed) return;
			if (!this.#rebuildSessionId) this.loadingAction = null;
			this.actionError = cause instanceof Error ? cause.message : 'Could not start rebuild';
			// A viewer failure must not hide or cancel an already accepted build.
			if (this.#rebuildSessionId) void this.#pollRebuild();
		}
	}

	/** Run one allowlisted lifecycle action. Delete asks for confirmation first. */
	async run(action: ContainerAction): Promise<void> {
		if (this.loadingAction !== null) return;
		if (action === 'delete' && !confirm('Delete this container? This cannot be undone.')) return;
		const { id, onRefresh } = this.#options();
		this.loadingAction = action;
		this.actionError = '';
		try {
			const response = await fetch(`/api/containers/${id}/${action}`, { method: 'POST' });
			if (!response.ok) throw new Error(await responseError(response));
			await onRefresh();
		} catch (cause) {
			this.actionError = cause instanceof Error ? cause.message : 'Container action failed';
		} finally {
			this.loadingAction = null;
		}
	}
}
