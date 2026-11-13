import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	DevcontainerBuildConflict,
	startDevcontainerBuild,
	removeDevcontainerBuild
} from '$lib/server/devcontainerBuilds';
import { DevcontainerTargetError, resolveDevcontainerTarget } from '$lib/server/devcontainerRebuild';
import { randomUUID } from 'node:crypto';
import { normalize, join, relative } from 'node:path';
import { access } from 'node:fs/promises';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);

	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');

	const { repoPath, repoName, configPath } = body as Record<string, unknown>;

	if (typeof repoPath !== 'string' || !repoPath.trim()) throw error(400, 'repoPath is required');
	if (typeof repoName !== 'string' || !repoName.trim()) throw error(400, 'repoName is required');
	if (configPath !== undefined && (typeof configPath !== 'string' || !configPath.trim())) {
		throw error(400, 'configPath must be a non-empty string');
	}

	const normalized = normalize(repoPath.trim());
	let selectedConfig = typeof configPath === 'string' ? join(normalized, configPath.trim()) : undefined;
	// Preserve CLI default discovery, but validate the selected default before acquiring a build lock.
	if (!selectedConfig) {
		for (const candidate of ['.devcontainer/devcontainer.json', '.devcontainer.json']) {
			try {
				await access(join(normalized, candidate));
				selectedConfig = join(normalized, candidate);
				break;
			} catch {
				// Try the next supported CLI default. Named configurations require an explicit selection.
			}
		}
	}
	if (!selectedConfig) throw error(400, 'No default devcontainer configuration. Select a configuration.');

	try {
		const target = await resolveDevcontainerTarget(WORKSPACE_ROOT, normalized, selectedConfig);
		const build = startDevcontainerBuild(
			randomUUID(),
			target.repoPath,
			repoName.trim(),
			relative(target.repoPath, target.configPath)
		);
		return json({ id: build.id, repoPath: build.repoPath });
	} catch (cause) {
		if (cause instanceof DevcontainerTargetError) throw error(400, cause.message);
		if (cause instanceof DevcontainerBuildConflict) throw error(409, cause.message);
		throw error(503, 'Could not start build. Check Dev Containers CLI availability and terminal capacity.');
	}
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);

	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');

	const { id } = body as Record<string, unknown>;

	if (typeof id !== 'string' || !id.trim()) throw error(400, 'id is required');

	await removeDevcontainerBuild(id.trim());

	return json({ success: true });
};
