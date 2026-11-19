/**
 * Browser state for Brain shell access. The dashboard page creates one instance and provides
 * it as context, so container rows and cards read grants without extra props.
 */
import { getContext, setContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import type {
	BrainController,
	BrainExecutionStatus,
	BrainExecutionView,
	BrainGrantRequest,
	BrainGrantView,
	BrainStatus,
	BrainTargetPreview
} from '$lib/brainTypes';
import { errorMessage, latestRequest, requestJson } from '$lib/requests';

const CONTEXT_KEY = Symbol('brain-access');
const TAB_PREFIX = 'brain:';

/** Terminal drawer ID of a Brain command tab. Shell tabs never use this prefix. */
export function brainTabId(executionId: string): string {
	return `${TAB_PREFIX}${executionId}`;
}

/** Execution ID of a Brain tab, or null for a shell tab. */
export function brainExecutionIdOf(tabId: string | null): string | null {
	return tabId?.startsWith(TAB_PREFIX) ? tabId.slice(TAB_PREFIX.length) : null;
}

/** True until the command has a final status. */
export function isRunningStatus(status: BrainExecutionStatus): boolean {
	return status === 'running' || status === 'stopping';
}

export class BrainAccess {
	status = $state<BrainStatus | null>(null);
	error = $state('');
	/** Clock for grant countdowns; `refresh` advances it */
	now = $state(Date.now());
	/** The page sets this to open the terminal drawer on one Brain tab. */
	revealHandler: ((executionId: string) => void) | undefined;
	readonly #reads = latestRequest();
	/** Commands with an open tab. Running commands open one automatically. */
	readonly #opened = new SvelteSet<string>();
	/** Running commands whose tab the operator closed; they do not reopen automatically. */
	readonly #dismissed = new SvelteSet<string>();

	get enabled(): boolean {
		return this.status?.enabled ?? false;
	}

	/** Grant for a container, by the short ID that rows use. */
	grantFor(containerId: string): BrainGrantView | undefined {
		return this.status?.grants.find((grant) => grant.containerId === containerId);
	}

	/** Commands with a terminal tab, oldest first. A closed tab never stops its command. */
	get tabs(): BrainExecutionView[] {
		return (this.status?.executions ?? [])
			.filter((execution) => this.#opened.has(execution.id))
			.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	}

	/** Open a tab for a command, also for one that ended. */
	openTab(executionId: string): void {
		this.#dismissed.delete(executionId);
		this.#opened.add(executionId);
	}

	/** Close a tab. The command continues. */
	closeTab(executionId: string): void {
		this.#opened.delete(executionId);
		this.#dismissed.add(executionId);
	}

	/** Open a tab and show it in the terminal drawer. */
	reveal(executionId: string): void {
		this.openTab(executionId);
		this.revealHandler?.(executionId);
	}

	/** Open tabs for running commands that the operator has not closed. */
	#openRunningTabs(status: BrainStatus): void {
		for (const execution of status.executions)
			if (isRunningStatus(execution.status) && !this.#dismissed.has(execution.id))
				this.#opened.add(execution.id);
	}

	/** Read status. A failure keeps the last known status and reports that it may be outdated. */
	async refresh(): Promise<void> {
		this.now = Date.now();
		try {
			await this.#reads.run(
				(signal) => requestJson<BrainStatus>('/api/brain', { signal }),
				(value) => {
					this.#openRunningTabs(value);
					this.status = value;
					this.error = '';
				}
			);
		} catch (cause) {
			this.error = `Brain access status may be outdated. ${errorMessage(cause)}`;
		}
	}

	/** What a grant would allow, inspected from live Docker state. */
	preview(containerId: string): Promise<BrainTargetPreview> {
		return requestJson<BrainTargetPreview>(
			`/api/brain/targets/${encodeURIComponent(containerId)}`
		);
	}

	async grant(request: BrainGrantRequest): Promise<void> {
		await requestJson('/api/brain/grants', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request)
		});
		await this.refresh();
	}

	async revoke(grantId: string): Promise<void> {
		await requestJson(`/api/brain/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' });
		await this.refresh();
	}

	async revokeAll(): Promise<void> {
		await requestJson('/api/brain/grants', { method: 'DELETE' });
		await this.refresh();
	}

	async stop(executionId: string): Promise<void> {
		await requestJson(`/api/brain/executions/${encodeURIComponent(executionId)}`, {
			method: 'DELETE'
		});
		await this.refresh();
	}

	/** Give terminal input to the operator (`operator`) or back to Brain (`brain`). */
	async setController(executionId: string, controller: BrainController): Promise<void> {
		await requestJson(`/api/brain/executions/${encodeURIComponent(executionId)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ controller })
		});
		await this.refresh();
	}

	dispose(): void {
		this.#reads.cancel();
	}
}

/** Create the page instance and make it available to descendants. */
export function provideBrainAccess(): BrainAccess {
	return setContext(CONTEXT_KEY, new BrainAccess());
}

/** The page instance, or undefined outside the dashboard page (for example in tests). */
export function useBrainAccess(): BrainAccess | undefined {
	return getContext<BrainAccess | undefined>(CONTEXT_KEY);
}

/** Remaining grant time, compact: `3h 20m`, `47m`, or `<1m`. */
export function formatRemaining(expiresAt: string, now: number): string {
	const minutes = Math.floor((Date.parse(expiresAt) - now) / 60_000);
	if (minutes < 1) return '<1m';
	if (minutes < 60) return `${minutes}m`;
	const rest = minutes % 60;
	return rest ? `${Math.floor(minutes / 60)}h ${rest}m` : `${Math.floor(minutes / 60)}h`;
}
