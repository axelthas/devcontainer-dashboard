/** Authenticated POST opens a directory-scoped UI/PTY, never an OpenCode conversation. */
import { error, json } from '@sveltejs/kit';
import { openAi } from '$lib/server/aiRuntime';
import { validAiId } from '$lib/server/aiSessions';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (
		!body ||
		!validAiId(body.launch) ||
		(body.tool !== 'opencode' && body.tool !== 'openchamber') ||
		typeof body.path !== 'string' ||
		body.path.length > 4096 ||
		body.path.includes('\0')
	)
		error(400, 'A directory, tool and window identity are required.');
	try {
		return json(await openAi({ launch: body.launch, tool: body.tool, path: body.path }), {
			headers: { 'Cache-Control': 'no-store' }
		});
	} catch {
		error(503, 'Cannot open AI. Check AI status and container logs.');
	}
};
