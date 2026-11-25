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
	BrainGrantExtension,
	BrainGrantMinutes,
	BrainGrantRequest,
	BrainGrantView,
	BrainStatus,
	BrainTargetPreview
} from '$lib/brainTypes';
import { brainAlerts } from '$lib/brainAlerts';
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

/** Browser notification permission, or `unsupported` without the API or a secure context. */
export type BrainNotificationState = NotificationPermission | 'unsupported';

function notificationState(): BrainNotificationState {
	return typeof Notification === 'undefined' || !globalThis.isSecureContext
		? 'unsupported'
		: Notification.permission;
}

export class BrainAccess {
	status = $state<BrainStatus | null>(null);
	/** Whether ending grants and Brain's time requests raise browser notifications */
	notifications = $state<BrainNotificationState>(notificationState());
	error = $state('');
	/** Clock for grant countdowns; `refresh` advances it */
	now = $state(Date.now());
	/** The page sets this to open the terminal drawer on one Brain tab. */
	revealHandler: ((executionId: string) => void) | undefined;
	/** The page sets this to show the Brain pane, so container rows can jump to their group. */
	focusHandler: (() => void) | undefined;
	/** The group that the Brain pane scrolls to and highlights, until it clears */
	focusRequest = $state<{ grantId: string; at: number } | null>(null);
	readonly #reads = latestRequest();
	/**
	 * Commands with an open terminal tab. A tab opens only when the operator asks for it; the
	 * Brain pane shows each command's goal, status and output without one.
	 */
	readonly #opened = new SvelteSet<string>();
	/** Alert keys that already raised a notification in this page session */
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping only; nothing renders from it
	readonly #alerted = new Set<string>();
	#focusTimer: ReturnType<typeof setTimeout> | undefined;
	#focusVersion = 0;

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
		this.#opened.add(executionId);
	}

	/** Close a tab. The command continues. */
	closeTab(executionId: string): void {
		this.#opened.delete(executionId);
	}

	/** Open a tab and show it in the terminal drawer. */
	reveal(executionId: string): void {
		this.openTab(executionId);
		this.revealHandler?.(executionId);
	}

	/** Show the Brain pane on one container's group; the highlight clears after a moment. */
	focus(grantId: string): void {
		this.focusHandler?.();
		clearTimeout(this.#focusTimer);
		const version = ++this.#focusVersion;
		this.focusRequest = { grantId, at: Date.now() };
		this.#focusTimer = setTimeout(() => {
			if (this.#focusVersion === version) this.focusRequest = null;
		}, 2000);
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
					this.#raiseAlerts();
				}
			);
		} catch (cause) {
			this.error = `Brain access status may be outdated. ${errorMessage(cause)}`;
		}
	}

	/** Advance the countdown clock without a status read, for live warnings. */
	tick(): void {
		this.now = Date.now();
	}

	/**
	 * Ask for notification permission. Browsers allow the prompt only after an operator
	 * action, so the Grant, Extend and notification buttons call this.
	 */
	async enableNotifications(): Promise<void> {
		if (this.notifications !== 'default') return;
		try {
			this.notifications = await Notification.requestPermission();
		} catch {
			this.notifications = notificationState();
		}
		this.#raiseAlerts();
	}

	/** Notify once per ending grant and per time request. A click shows that grant. */
	#raiseAlerts(): void {
		if (this.notifications !== 'granted') return;
		for (const alert of brainAlerts(this.status, Date.now())) {
			if (this.#alerted.has(alert.key)) continue;
			this.#alerted.add(alert.key);
			try {
				const notification = new Notification(alert.title, { body: alert.body, tag: alert.key });
				notification.onclick = () => {
					window.focus();
					this.focus(alert.grantId);
					notification.close();
				};
			} catch {
				// Some mobile browsers allow notifications only from a service worker.
				this.notifications = 'unsupported';
				return;
			}
		}
	}

	/** What a grant would allow, inspected from live Docker state. */
	preview(containerId: string): Promise<BrainTargetPreview> {
		return requestJson<BrainTargetPreview>(`/api/brain/targets/${encodeURIComponent(containerId)}`);
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

	/** Add time to the current end of a grant. */
	async extend(grantId: string, minutes: BrainGrantMinutes): Promise<void> {
		const body: BrainGrantExtension = { minutes };
		await requestJson(`/api/brain/grants/${encodeURIComponent(grantId)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		await this.refresh();
	}

	/** Dismiss Brain's pending request for more time. The grant does not change. */
	async dismissTimeRequest(grantId: string): Promise<void> {
		await requestJson(`/api/brain/grants/${encodeURIComponent(grantId)}/time-request`, {
			method: 'DELETE'
		});
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
		clearTimeout(this.#focusTimer);
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
