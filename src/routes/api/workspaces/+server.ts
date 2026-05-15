import { json } from '@sveltejs/kit';
import { loadWorkspaces } from '$lib/server/workspaces';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return json(await loadWorkspaces());
};
