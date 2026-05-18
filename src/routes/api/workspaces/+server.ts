import { json, error } from '@sveltejs/kit';
import { rm } from 'node:fs/promises';
import { loadWorkspaces, WORKSPACE_ROOT } from '$lib/server/workspaces';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return json(await loadWorkspaces());
};

export const DELETE: RequestHandler = async ({ request }) => {
	const { path } = await request.json();

	if (typeof path !== 'string' || !path.startsWith(WORKSPACE_ROOT + '/')) {
		throw error(400, 'Invalid workspace path');
	}

	// Prevent path traversal
	const normalized = new URL('file://' + path).pathname;
	if (!normalized.startsWith(WORKSPACE_ROOT + '/')) {
		throw error(400, 'Invalid workspace path');
	}

	try {
		await rm(normalized, { recursive: true, force: true });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		throw error(500, message);
	}

	return json({ success: true });
};
