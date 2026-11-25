/**
 * Grant lifecycle. Only the authenticated dashboard creates grants; the MCP endpoint can only
 * use them. A grant ends on expiry, on revocation, or when its container run ends: a stop,
 * restart or rebuild produces a new `StartedAt` or container ID, which never matches.
 *
 * Only the operator extends a grant. Brain can ask for more time with `request_more_time`;
 * the request is shown to the operator and changes nothing by itself.
 */
import { randomBytes } from 'node:crypto';
import {
	BRAIN_GRANT_MINUTES,
	type BrainGrantMinutes,
	type BrainGrantView,
	type BrainStatus
} from '../../brainTypes.js';
import type { BrainGrant } from './state.js';
import { AUDIT_LIMIT, brainDocker, brainState, recordAudit } from './state.js';
import { executionView, isActive, stopExecution } from './executions.js';

export const MAX_GRANTS = 16;

export class BrainAccessError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = 'BrainAccessError';
		this.status = status;
	}
}

/** Target fields that the operator reviewed; the store adds identity and lifetime. */
export type BrainGrantTarget = Omit<BrainGrant, 'id' | 'createdAt' | 'expiresAt'>;

/** End a grant and request termination of its running commands. */
export function revokeGrant(id: string, reason: string, now = Date.now()): boolean {
	const grant = brainState.grants.get(id);
	if (!grant) return false;
	brainState.grants.delete(id);
	for (const execution of brainState.executions.values())
		if (execution.grantId === id && isActive(execution))
			void stopExecution(execution.id, reason).catch(() => undefined);
	recordAudit({ tool: 'revoke', target: grant.containerName, detail: reason, outcome: 'ok' }, now);
	return true;
}

/** End every grant, for the operator's revoke-all action. */
export function revokeAllGrants(reason: string, now = Date.now()): number {
	const ids = [...brainState.grants.keys()];
	for (const id of ids) revokeGrant(id, reason, now);
	return ids.length;
}

/** End grants whose lifetime has passed. */
export function pruneExpiredGrants(now = Date.now()): void {
	for (const grant of [...brainState.grants.values()])
		if (grant.expiresAt <= now) revokeGrant(grant.id, 'The grant expired', now);
}

/** Store a new grant for one reviewed container run. */
export function createGrant(
	target: BrainGrantTarget,
	minutes: BrainGrantMinutes,
	now = Date.now()
): BrainGrant {
	pruneExpiredGrants(now);
	if (!BRAIN_GRANT_MINUTES.includes(minutes))
		throw new BrainAccessError(`Choose ${BRAIN_GRANT_MINUTES.join(', ')} minutes`, 400);
	for (const grant of brainState.grants.values())
		if (grant.containerId === target.containerId)
			throw new BrainAccessError(
				'Brain already has access to this container. Revoke it first.',
				409
			);
	if (brainState.grants.size >= MAX_GRANTS)
		throw new BrainAccessError(`At most ${MAX_GRANTS} containers can be granted at once`, 409);
	const grant: BrainGrant = {
		...target,
		id: `g_${randomBytes(12).toString('base64url')}`,
		createdAt: now,
		expiresAt: now + minutes * 60_000
	};
	brainState.grants.set(grant.id, grant);
	recordAudit(
		{
			tool: 'grant',
			target: grant.containerName,
			detail: `as ${grant.user} for ${minutes} minutes`,
			outcome: 'ok'
		},
		now
	);
	return grant;
}

/**
 * Add time to the current end of a live grant, for the operator's Extend action. The grant
 * keeps its container run, user and reach, so no new review is needed. A pending time
 * request from Brain is answered by the extension and cleared.
 */
export async function extendGrant(
	id: string,
	minutes: BrainGrantMinutes,
	now = Date.now()
): Promise<BrainGrant> {
	if (!BRAIN_GRANT_MINUTES.includes(minutes))
		throw new BrainAccessError(`Choose ${BRAIN_GRANT_MINUTES.join(', ')} minutes`, 400);
	pruneExpiredGrants(now);
	if (!brainState.grants.has(id))
		throw new BrainAccessError('The grant has already ended. Grant access again.', 404);
	let grant: BrainGrant;
	try {
		grant = await liveGrant(id, now);
	} catch (cause) {
		// liveGrant words its refusal for Brain; the operator needs the dashboard wording.
		if (cause instanceof BrainAccessError && cause.status === 410)
			throw new BrainAccessError(
				'The container stopped, restarted or was removed, so the grant ended. Grant access again.',
				410
			);
		throw cause;
	}
	grant.expiresAt += minutes * 60_000;
	grant.timeRequest = undefined;
	recordAudit(
		{
			tool: 'extend',
			target: grant.containerName,
			grantId: grant.id,
			detail: `by ${minutes} minutes, ends ${new Date(grant.expiresAt).toISOString()}`,
			outcome: 'ok'
		},
		now
	);
	return grant;
}

/** Store Brain's request for more time. It replaces an earlier request and grants nothing. */
export function requestTime(
	grant: BrainGrant,
	minutes: BrainGrantMinutes,
	reason: string,
	now = Date.now()
): void {
	grant.timeRequest = { minutes, reason, at: now, status: 'pending' };
}

/** Dismiss Brain's pending request. Brain sees the dismissal in `list_targets`. */
export function dismissTimeRequest(id: string, now = Date.now()): boolean {
	pruneExpiredGrants(now);
	const grant = brainState.grants.get(id);
	if (grant?.timeRequest?.status !== 'pending') return false;
	grant.timeRequest.status = 'dismissed';
	recordAudit(
		{
			tool: 'dismiss_time_request',
			target: grant.containerName,
			grantId: grant.id,
			detail: `${grant.timeRequest.minutes} minutes`,
			outcome: 'ok'
		},
		now
	);
	return true;
}

/** Return the grant while it still applies to the same running container run; end it otherwise. */
export async function liveGrant(id: string, now = Date.now()): Promise<BrainGrant> {
	pruneExpiredGrants(now);
	const grant = brainState.grants.get(id);
	if (!grant) throw new BrainAccessError('Unknown or expired target_id. Call list_targets.', 404);
	let info;
	try {
		info = await brainDocker().getContainer(grant.containerId).inspect();
	} catch {
		info = undefined;
	}
	if (
		!info ||
		info.Id !== grant.containerId ||
		!info.State?.Running ||
		info.State.StartedAt !== grant.startedAt
	) {
		revokeGrant(grant.id, 'The container stopped, restarted or was removed', now);
		throw new BrainAccessError(
			'Access ended: the container stopped, restarted or was removed. Ask the operator for a new grant.',
			410
		);
	}
	return grant;
}

/** Check every grant against Docker, so the dashboard shows only grants that still apply. */
export async function reconcileGrants(now = Date.now()): Promise<void> {
	await Promise.all(
		[...brainState.grants.keys()].map((id) => liveGrant(id, now).catch(() => undefined))
	);
}

/** Operator and MCP view of one grant. */
export function grantView(grant: BrainGrant): BrainGrantView {
	return {
		id: grant.id,
		intent: grant.intent,
		...(grant.timeRequest?.status === 'pending'
			? { timeRequest: { ...grant.timeRequest, at: new Date(grant.timeRequest.at).toISOString() } }
			: {}),
		containerId: grant.containerId.slice(0, 12),
		containerName: grant.containerName,
		kind: grant.kind,
		startedAt: grant.startedAt,
		user: grant.user,
		userSource: grant.userSource,
		workdir: grant.workdir,
		composeProject: grant.composeProject,
		composeService: grant.composeService,
		localFolder: grant.localFolder,
		exposure: grant.exposure,
		createdAt: new Date(grant.createdAt).toISOString(),
		expiresAt: new Date(grant.expiresAt).toISOString(),
		runningExecutions: [...brainState.executions.values()].filter(
			(execution) => execution.grantId === grant.id && isActive(execution)
		).length
	};
}

/** Everything the dashboard shows, newest first. */
export function brainStatus(now = Date.now()): BrainStatus {
	pruneExpiredGrants(now);
	return {
		enabled: Boolean(brainState.gateway),
		publicUrl: brainState.gateway?.publicUrl,
		grants: [...brainState.grants.values()].map(grantView),
		executions: [...brainState.executions.values()]
			.sort((a, b) => b.startedAt - a.startedAt)
			.slice(0, 30)
			.map(executionView),
		// The dashboard shows each call with its command, so it needs the whole retained log.
		audit: brainState.audit.slice(-AUDIT_LIMIT).reverse()
	};
}
