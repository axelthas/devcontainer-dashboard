/**
 * Operator alerts for Brain grants: a grant that ends soon, and Brain's request for more
 * time. Pure functions, so the browser notification code and tests share one rule.
 */
import { BRAIN_GRANT_WARNING_MINUTES, type BrainGrantView, type BrainStatus } from './brainTypes';

export interface BrainAlert {
	/** Stable per event: one notification per grant end and per request */
	key: string;
	grantId: string;
	title: string;
	body: string;
}

/** True from the warning threshold until the grant ends. */
export function isEndingSoon(grant: Pick<BrainGrantView, 'expiresAt'>, now: number): boolean {
	const left = Date.parse(grant.expiresAt) - now;
	return left > 0 && left <= BRAIN_GRANT_WARNING_MINUTES * 60_000;
}

/** Time left as m:ss, for the live warning. */
export function formatCountdown(expiresAt: string, now: number): string {
	const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Grant duration in operator words: `15 minutes`, `1 hour`, `4 hours`. */
export function durationLabel(minutes: number): string {
	if (minutes < 60) return `${minutes} minutes`;
	return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
}

/** Clock time of an ISO instant or epoch milliseconds, for end times. */
export function clockTime(at: string | number): string {
	return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Alerts for the current status. An extension changes `expiresAt`, so the warning for the
 * new end is a new event; a new request has a new `at`.
 */
export function brainAlerts(status: BrainStatus | null, now: number): BrainAlert[] {
	const alerts: BrainAlert[] = [];
	for (const grant of status?.grants ?? []) {
		if (grant.timeRequest)
			alerts.push({
				key: `${grant.id}:request:${grant.timeRequest.at}`,
				grantId: grant.id,
				title: `Brain asks for ${durationLabel(grant.timeRequest.minutes)} more in ${grant.containerName}`,
				body: grant.timeRequest.reason
			});
		if (isEndingSoon(grant, now)) {
			const running = grant.runningExecutions;
			alerts.push({
				key: `${grant.id}:ending:${grant.expiresAt}`,
				grantId: grant.id,
				title: `Brain access to ${grant.containerName} ends at ${clockTime(grant.expiresAt)}`,
				body: running
					? `${running} running ${running === 1 ? 'command stops' : 'commands stop'} then. Open DevHarbour to extend access.`
					: 'Open DevHarbour to extend access.'
			});
		}
	}
	return alerts;
}
