import { error, json } from '@sveltejs/kit';
import { dismissTimeRequest } from '$lib/server/brain/access';
import type { RequestHandler } from './$types';

/** Dismiss Brain's pending request for more time. The grant does not change. */
export const DELETE: RequestHandler = async ({ params }) => {
	if (!dismissTimeRequest(params.id))
		throw error(404, 'There is no pending request for this grant. Refresh the dashboard.');
	return json({ dismissed: 1 });
};
