import { json, error } from '@sveltejs/kit';
import { rm } from 'node:fs/promises';
import { loadMergedWorkspaces, WORKSPACE_ROOT } from '$lib/server/workspaces';
import { getActiveRuns, removeBootstrapRun } from '$lib/server/bootstrapRuns';
import { getActiveBuilds, removeDevcontainerBuild } from '$lib/server/devcontainerBuilds';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return json(await loadMergedWorkspaces());
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

	// Remove any in-memory bootstrap runs whose workspace path matches the deleted path.
	// Without this the placeholder would reappear on the next poll.
	for (const run of getActiveRuns()) {
		if (run.workspacePath === normalized || run.workspacePath.startsWith(normalized + '/')) {
			removeBootstrapRun(run.id);
		}
	}

	// Remove any in-memory devcontainer builds for repos under the deleted workspace.
	for (const build of getActiveBuilds()) {
		if (build.repoPath === normalized || build.repoPath.startsWith(normalized + '/')) {
			removeDevcontainerBuild(build.id);
		}
	}

	return json({ success: true });
};
