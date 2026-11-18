/**
 * Browser state for Brain shell access. The dashboard page creates one instance and provides
 * it as context, so container rows and cards read grants without extra props.
 */
import { getContext, setContext } from 'svelte';
import type {
	BrainGrantRequest,
	BrainGrantView,
	BrainStatus,
	BrainTargetPreview
} from '$lib/brainTypes';
import { errorMessage, latestRequest, requestJson } from '$lib/requests';

const CONTEXT_KEY = Symbol('brain-access');

export class BrainAccess {
	status = $state<BrainStatus | null>(null);
	error = $state('');
	/** Clock for grant countdowns; `refresh` advances it */
	now = $state(Date.now());
	readonly #reads = latestRequest();

	get enabled(): boolean {
		return this.status?.enabled ?? false;
	}

	/** Grant for a container, by the short ID that rows use. */
	grantFor(containerId: string): BrainGrantView | undefined {
		return this.status?.grants.find((grant) => grant.containerId === containerId);
	}

	/** Read status. A failure keeps the last known status and reports that it may be outdated. */
	async refresh(): Promise<void> {
		this.now = Date.now();
		try {
			await this.#reads.run(
				(signal) => requestJson<BrainStatus>('/api/brain', { signal }),
				(value) => {
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
