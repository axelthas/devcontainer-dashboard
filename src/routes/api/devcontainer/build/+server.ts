import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { startDevcontainerBuild } from '$lib/server/devcontainerBuilds';
import { randomUUID } from 'node:crypto';
import { normalize } from 'node:path';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);

	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');

	const { repoPath, repoName } = body as Record<string, unknown>;

	if (typeof repoPath !== 'string' || !repoPath.trim()) throw error(400, 'repoPath is required');
	if (typeof repoName !== 'string' || !repoName.trim()) throw error(400, 'repoName is required');

	// Security: ensure repoPath is within WORKSPACE_ROOT to prevent path traversal
	const normalized = normalize(repoPath.trim());
	if (!normalized.startsWith(WORKSPACE_ROOT + '/')) {
		throw error(400, 'repoPath must be within workspace root');
	}

	const id = randomUUID();
	const build = startDevcontainerBuild(id, normalized, repoName.trim());

	return json({ id: build.id, repoPath: build.repoPath });
};
