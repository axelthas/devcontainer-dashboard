import { json, error } from '@sveltejs/kit';
import { rm } from 'node:fs/promises';
import { loadWorkspaces, WORKSPACE_ROOT } from '$lib/server/workspaces';
import { getActiveRuns } from '$lib/server/bootstrapRuns';
import { getActiveBuilds } from '$lib/server/devcontainerBuilds';
import type { LocalWorkspaceData } from '$lib/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const [workspaces, runs, devcontainerBuilds] = await Promise.all([
		loadWorkspaces(),
		Promise.resolve(getActiveRuns()),
		Promise.resolve(getActiveBuilds())
	]);

	// Merge active bootstrap runs into the workspace list
	for (const run of runs) {
		const existing = workspaces.find((w) => w.path === run.workspacePath);
		const buildSession = { id: run.id, status: run.status, startedAt: run.startedAt };

		if (existing) {
			// Real workspace already on disk — attach session to it (e.g. success transition)
			existing.buildSession = buildSession;
		} else {
			// Workspace not on disk yet (still building or failed) — inject placeholder.
			// Use run.name (the preset name) as the display name rather than the generated dir.
			const placeholder: LocalWorkspaceData = {
				id: run.id,
				name: run.name,
				path: run.workspacePath,
				repos: [],
				buildSession
			};
			workspaces.push(placeholder);
		}
	}

	// Merge active devcontainer builds into the matching repo inside each workspace
	for (const build of devcontainerBuilds) {
		for (const ws of workspaces) {
			const repo = ws.repos.find((r) => r.path === build.repoPath);
			if (repo) {
				repo.buildSession = { id: build.id, status: build.status, startedAt: build.startedAt };
				break;
			}
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
