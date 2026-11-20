import { error, json } from '@sveltejs/kit';
import { BRAIN_GRANT_MINUTES, type BrainGrantMinutes } from '$lib/brainTypes';
import { createGrant, grantView, revokeAllGrants } from '$lib/server/brain/access';
import { requiresAcceptance } from '$lib/server/brain/exposure';
import { brainHttpError } from '$lib/server/brain/http';
import { brainState } from '$lib/server/brain/state';
import { inspectBrainTarget } from '$lib/server/brain/targets';
import type { RequestHandler } from './$types';

/**
 * Grant Brain shell access to the container run that the operator reviewed. The server
 * inspects the container again, so a restart or a changed risk list needs a new review.
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!brainState.gateway) throw error(409, 'The Brain MCP endpoint is not enabled.');
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}
	const fields = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
	const { containerId, startedAt, minutes, acceptRisks } = fields;
	if (
		typeof containerId !== 'string' ||
		typeof startedAt !== 'string' ||
		typeof acceptRisks !== 'boolean' ||
		!BRAIN_GRANT_MINUTES.includes(minutes as BrainGrantMinutes)
	)
		throw error(400, 'Send containerId, startedAt, minutes and acceptRisks');
	try {
		const { target } = await inspectBrainTarget(containerId);
		if (target.startedAt !== startedAt)
			throw error(409, 'The container restarted after you reviewed it. Review it again.');
		if (requiresAcceptance(target.exposure) && !acceptRisks)
			throw error(400, 'Accept the listed risks to grant access to this container.');
		const grant = createGrant(target, minutes as BrainGrantMinutes);
		return json(grantView(grant), { status: 201 });
	} catch (cause) {
		brainHttpError(cause);
	}
};

/** Revoke every grant and request termination of its running commands. */
export const DELETE: RequestHandler = async () => {
	return json({ revoked: revokeAllGrants('Revoked by the operator') });
};
