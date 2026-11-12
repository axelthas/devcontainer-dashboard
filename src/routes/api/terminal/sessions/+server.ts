/** Authenticated explicit process creation and cancellation; WebSockets only attach. */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	createPersistentSession,
	getPersistentSession,
	killPersistentSession,
	listPersistentSessions,
	validSessionId,
	validSessionKind
} from '$lib/server/terminal';

export const GET: RequestHandler = ({ url }) => {
	const id = url.searchParams.get('id');
	if (id !== null) {
		if (!validSessionId(id)) throw error(400, 'Invalid session id');
		const session = getPersistentSession(id);
		if (!session) throw error(404, 'Session no longer exists');
		return json({ id, status: session.status, exitCode: session.exitCode });
	}
	return json(listPersistentSessions('shell'));
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || !validSessionId(body.id) || !validSessionKind(body.kind ?? 'shell'))
		throw error(400, 'Invalid terminal identity');
	if (
		(body.command !== undefined &&
			(typeof body.command !== 'string' || body.command.length > 32_768)) ||
		(body.cwd !== undefined &&
			(typeof body.cwd !== 'string' || body.cwd.length > 4096 || body.cwd.includes('\0'))) ||
		(body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 200))
	)
		throw error(400, 'Invalid terminal options');
	const existed = Boolean(getPersistentSession(body.id));
	try {
		createPersistentSession(
			body.id,
			body.command || undefined,
			body.cwd ?? process.env.WORKSPACE_ROOT ?? '/workspaces',
			{ name: body.name, kind: body.kind ?? 'shell' }
		);
	} catch (cause) {
		console.error('Could not create terminal', cause);
		throw error(503, 'Could not create terminal session');
	}
	return json({ id: body.id }, { status: existed ? 200 : 201 });
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || !validSessionId(body.id)) throw error(400, 'Invalid session id');
	await killPersistentSession(body.id);
	return json({ success: true });
};
