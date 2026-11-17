import { error, json } from '@sveltejs/kit';
import { disconnectContainerNetwork, NetworkRequestError } from '$lib/server/networks';
import type { RequestHandler } from './$types';

/** Disconnect a devcontainer from one user-defined network. */
export const DELETE: RequestHandler = async ({ params }) => {
	try {
		return json(await disconnectContainerNetwork(params.id, params.network));
	} catch (cause) {
		if (cause instanceof NetworkRequestError) throw error(cause.status, cause.message);
		throw error(
			503,
			'Docker did not complete the request. Refresh the dashboard to see the state.'
		);
	}
};
