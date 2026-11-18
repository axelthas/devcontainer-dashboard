import { json } from '@sveltejs/kit';
import { brainStatus, reconcileGrants } from '$lib/server/brain/access';
import type { RequestHandler } from './$types';

/** Grants, recent executions and the audit log. Grants are checked against Docker first. */
export const GET: RequestHandler = async () => {
	await reconcileGrants();
	return json(brainStatus(), { headers: { 'Cache-Control': 'no-store' } });
};
