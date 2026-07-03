import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { startDevcontainerBuild, removeDevcontainerBuild } from '$lib/server/devcontainerBuilds';
import { randomUUID } from 'node:crypto';
import { normalize, join } from 'node:path';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);

	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');

	const { repoPath, repoName, configPath } = body as Record<string, unknown>;

	if (typeof repoPath !== 'string' || !repoPath.trim()) throw error(400, 'repoPath is required');
	if (typeof repoName !== 'string' || !repoName.trim()) throw error(400, 'repoName is required');

	// Security: ensure repoPath is within WORKSPACE_ROOT to prevent path traversal
	const normalized = normalize(repoPath.trim());
	if (!normalized.startsWith(WORKSPACE_ROOT + '/')) {
		throw error(400, 'repoPath must be within workspace root');
	}

	let validatedConfigPath: string | undefined;
	if (configPath !== undefined) {
		if (typeof configPath !== 'string' || !configPath.trim()) {
			throw error(400, 'configPath must be a non-empty string');
		}
		// Security: ensure configPath resolves to a path inside the repo (no traversal)
		const absoluteConfig = normalize(join(normalized, configPath.trim()));
		if (!absoluteConfig.startsWith(normalized + '/')) {
			throw error(400, 'configPath must be within the repository');
		}
		validatedConfigPath = configPath.trim();
	}

	const id = randomUUID();
	const build = startDevcontainerBuild(id, normalized, repoName.trim(), validatedConfigPath);

	return json({ id: build.id, repoPath: build.repoPath });
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);

	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');

	const { id } = body as Record<string, unknown>;

	if (typeof id !== 'string' || !id.trim()) throw error(400, 'id is required');

	removeDevcontainerBuild(id.trim());

	return json({ success: true });
};
