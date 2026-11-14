/** Authenticated mutation: create a session in the validated folder, never run a prompt. */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openLocalChamber } from '$lib/server/localAi';

export const POST: RequestHandler = async ({ request, url }) => {
	if (request.headers.get('origin') !== url.origin) error(403, 'Matching Origin required.');
	let body: unknown;
	try { body = await request.json(); } catch { error(400, 'Invalid JSON.'); }
	if (!body || typeof body !== 'object' || !('path' in body) || typeof body.path !== 'string' || body.path.length > 4096) {
		error(400, 'A folder path is required.');
	}
	try {
		return json({ target: await openLocalChamber(body.path, url) }, { headers: { 'Cache-Control': 'no-store' } });
	} catch {
		error(503, 'Cannot open OpenChamber. Check Local AI status and container logs.');
	}
};
