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

	const id = randomUUID();

	// destDir is optional: interactive presets let the command ask for the directory itself.
	// When omitted, generate a unique placeholder used only for internal run tracking.
	const destDirRaw = typeof destDir === 'string' ? destDir.trim() : '';
	let normalizedDest: string;
	let workspacePath: string;

	if (destDirRaw) {
		normalizedDest = normalize(destDirRaw);
		if (normalizedDest.includes('/') || normalizedDest.includes('..') || normalizedDest === '.') {
			throw error(400, 'destDir must be a simple directory name');
		}
		workspacePath = normalize(WORKSPACE_ROOT + '/' + normalizedDest);
		if (!workspacePath.startsWith(WORKSPACE_ROOT + '/')) {
			throw error(400, 'Resolved path escapes workspace root');
		}
	} else {
		// No destDir provided — use a placeholder keyed on the run ID
		normalizedDest = '_bootstrap-' + id.slice(0, 8);
	}

	const run = startBootstrapRun(id, name.trim(), command.trim(), normalizedDest);

	return json({ id: run.id, workspacePath: run.workspacePath });
};
