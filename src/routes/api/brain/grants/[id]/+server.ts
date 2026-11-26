import { error, json } from '@sveltejs/kit';
import { BRAIN_GRANT_MINUTES, type BrainGrantMinutes } from '$lib/brainTypes';
import { extendGrant, grantView, revokeGrant } from '$lib/server/brain/access';
import { brainHttpError } from '$lib/server/brain/http';
import type { RequestHandler } from './$types';

/** Revoke one grant. Its running commands receive TERM, then KILL. */
export const DELETE: RequestHandler = async ({ params }) => {
	if (!revokeGrant(params.id, 'Revoked by the operator'))
		throw error(404, 'The grant has already ended. Refresh the dashboard.');
	return json({ revoked: 1 });
};

/**
 * Extend one live grant: add `minutes` to its current end. The server checks the container
 * run again first, so a restarted container is never extended.
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}
	const minutes =
		body && typeof body === 'object' ? (body as Record<string, unknown>).minutes : null;
	if (!BRAIN_GRANT_MINUTES.includes(minutes as BrainGrantMinutes))
		throw error(400, `Send minutes: one of ${BRAIN_GRANT_MINUTES.join(', ')}`);
	try {
		return json(grantView(await extendGrant(params.id, minutes as BrainGrantMinutes)));
	} catch (cause) {
		brainHttpError(cause);
	}
};
