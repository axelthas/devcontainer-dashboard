import { json, error } from '@sveltejs/kit';
import { rm } from 'node:fs/promises';
import { loadWorkspaces, WORKSPACE_ROOT } from '$lib/server/workspaces';
import { getActiveRuns } from '$lib/server/bootstrapRuns';
import type { LocalWorkspaceData } from '$lib/types';
import type { RequestHandler } from './$types';
import { basename } from 'node:path';

export const GET: RequestHandler = async () => {
	const [workspaces, runs] = await Promise.all([
		loadWorkspaces(),
		Promise.resolve(getActiveRuns())
	]);

	// Merge active bootstrap runs into the workspace list
	for (const run of runs) {
		const existing = workspaces.find((w) => w.path === run.workspacePath);
		const buildSession = { id: run.id, status: run.status, startedAt: run.startedAt };

		if (existing) {
			// Real workspace already on disk — attach session to it (e.g. success transition)
			existing.buildSession = buildSession;
		} else {
			// Workspace not on disk yet (still building or failed) — inject placeholder
			const placeholder: LocalWorkspaceData = {
				id: run.id,
				name: basename(run.workspacePath),
				path: run.workspacePath,
				repos: [],
				buildSession
			};
			workspaces.push(placeholder);
		}
	}

	return json(workspaces);
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
