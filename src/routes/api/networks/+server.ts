import { error, json } from '@sveltejs/kit';
import { listNetworkData, NetworkRequestError } from '$lib/server/networks';
import type { RequestHandler } from './$types';

/** User-defined Docker networks, with every container on them and their addresses. */
export const GET: RequestHandler = async () => {
	try {
		return json(await listNetworkData(), { headers: { 'Cache-Control': 'no-store' } });
	} catch (cause) {
		if (cause instanceof NetworkRequestError) throw error(cause.status, cause.message);
		throw error(503, 'Could not read Docker networks. Check the Docker socket.');
	}
};
