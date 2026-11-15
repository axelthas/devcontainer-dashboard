/** Authenticated mutation: create a session in the validated folder, never run a prompt. */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openLocalAi } from '$lib/server/localAi';
import { validAiLaunch } from '$lib/server/localAiSession';

export const POST: RequestHandler = async ({ request, url }) => {
	if (request.headers.get('origin') !== url.origin) error(403, 'Matching Origin required.');
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid JSON.');
	}
	if (
		!body ||
		typeof body !== 'object' ||
		!('path' in body) ||
		typeof body.path !== 'string' ||
		body.path.length > 4096
	) {
		error(400, 'A folder path is required.');
	}
	if (
		!('tool' in body) ||
		(body.tool !== 'opencode' && body.tool !== 'openchamber') ||
		!('launch' in body) ||
		!validAiLaunch(body.launch) ||
		!('instance' in body) ||
		typeof body.instance !== 'string' ||
		!/^[a-f0-9]{64}$/.test(body.instance)
	)
		error(400, 'A valid tool, launch identity and dashboard instance are required.');
	try {
		return json(
			await openLocalAi(
				{
					path: body.path,
					tool: body.tool,
					launch: body.launch,
					instance: body.instance
				},
				url
			),
			{ headers: { 'Cache-Control': 'no-store' } }
		);
	} catch {
		error(
			503,
			'Cannot open Local AI. Check service status, then open a new window from the dashboard.'
		);
	}
};
