import { handleMcpRequest } from '$lib/server/mcp';
import { listPolarisInstances, listPolarisSources } from '$lib/server/polaris-inventory';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request }) =>
	handleMcpRequest(request, {
		listInstances: listPolarisInstances,
		listSources: listPolarisSources
	});

// Stateless server: there is no event stream to open and no session to end.
const methodNotAllowed: RequestHandler = () =>
	new Response(null, { status: 405, headers: { Allow: 'POST' } });

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
