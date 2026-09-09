import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listPersistentSessions, killPersistentSession } from '$lib/server/terminal';

export const GET: RequestHandler = async () => {
	return json(listPersistentSessions('shell'));
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);

	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');

	const { id } = body as Record<string, unknown>;

	if (typeof id !== 'string' || !id.trim()) throw error(400, 'id is required');

	killPersistentSession(id.trim());

	return json({ success: true });
};
