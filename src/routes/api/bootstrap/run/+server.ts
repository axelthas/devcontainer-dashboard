import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { startBootstrapRun } from '$lib/server/bootstrapRuns';
import { randomUUID } from 'node:crypto';
import { normalize } from 'node:path';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);

	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');

	const { command, name, destDir } = body as Record<string, unknown>;

	if (typeof command !== 'string' || !command.trim()) throw error(400, 'command is required');
	if (typeof name !== 'string' || !name.trim()) throw error(400, 'name is required');
	if (typeof destDir !== 'string' || !destDir.trim()) throw error(400, 'destDir is required');

	// Prevent path traversal: destDir must be a single directory name with no separators
	const normalizedDest = normalize(destDir.trim());
	if (normalizedDest.includes('/') || normalizedDest.includes('..') || normalizedDest === '.') {
		throw error(400, 'destDir must be a simple directory name');
	}

	// Validate that the resolved workspace path stays within WORKSPACE_ROOT
	const workspacePath = normalize(WORKSPACE_ROOT + '/' + normalizedDest);
	if (!workspacePath.startsWith(WORKSPACE_ROOT + '/')) {
		throw error(400, 'Resolved path escapes workspace root');
	}

	const id = randomUUID();
	const run = startBootstrapRun(id, name.trim(), command.trim(), normalizedDest);

	return json({ id: run.id, workspacePath: run.workspacePath });
};
