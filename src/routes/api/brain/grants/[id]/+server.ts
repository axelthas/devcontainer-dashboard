import { error, json } from '@sveltejs/kit';
import { revokeGrant } from '$lib/server/brain/access';
import type { RequestHandler } from './$types';

/** Revoke one grant. Its running commands receive TERM, then KILL. */
export const DELETE: RequestHandler = async ({ params }) => {
	if (!revokeGrant(params.id, 'Revoked by the operator'))
		throw error(404, 'The grant has already ended. Refresh the dashboard.');
	return json({ revoked: 1 });
};
