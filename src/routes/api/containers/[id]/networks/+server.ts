import { error, json } from '@sveltejs/kit';
import { parseConnectRequest } from '$lib/networkRules';
import { connectContainerNetwork, NetworkRequestError } from '$lib/server/networks';
import type { RequestHandler } from './$types';

/** Connect a running devcontainer to an existing network. The body is a ConnectRequest. */
export const POST: RequestHandler = async ({ params, request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Expected a JSON body');
	}
	const parsed = parseConnectRequest(body);
	if ('error' in parsed) throw error(400, parsed.error);
	try {
		return json(await connectContainerNetwork(params.id, parsed.request));
	} catch (cause) {
		if (cause instanceof NetworkRequestError) throw error(cause.status, cause.message);
		throw error(
			503,
			'Docker did not complete the request. Refresh the dashboard to see the state.'
		);
	}
};
