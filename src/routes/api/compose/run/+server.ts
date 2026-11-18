/** Start or cancel one allowlisted Compose lifecycle action for a validated selection. */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { randomUUID } from 'node:crypto';
import docker from '$lib/server/docker';
import { isComposeAction } from '$lib/composeCommands';
import {
	ComposeConfigError,
	ComposeTargetError,
	ComposeUnavailableError,
	inspectComposeTarget,
	resolveComposeServices,
	resolveComposeTarget
} from '$lib/server/composeSandbox';
import { ComposeRunConflict, removeComposeRun, startComposeRun } from '$lib/server/composeRuns';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');
	const fields = body as Record<string, unknown>;
	const { repoPath, repoName, files, envFile, profiles, action, services } = fields;
	if (typeof repoName !== 'string' || !repoName.trim() || repoName.length > 200) {
		throw error(400, 'repoName is required');
	}
	if (!isComposeAction(action)) throw error(400, 'Unsupported Compose action');

	let target;
	let inspection;
	try {
		target = await resolveComposeTarget(WORKSPACE_ROOT, { repoPath, files, envFile, profiles });
		// Resolve again at start time: the files or the live stack can change after a check.
		inspection = await inspectComposeTarget(target, (options) => docker.listContainers(options));
	} catch (cause) {
		if (cause instanceof ComposeTargetError) throw error(400, cause.message);
		if (cause instanceof ComposeConfigError) throw error(422, cause.message);
		if (cause instanceof ComposeUnavailableError) throw error(503, cause.message);
		throw error(503, 'Could not inspect the Compose configuration. Check Docker availability.');
	}
	let selectedServices: string[];
	try {
		const available = inspection.services.map((service) => service.name);
		selectedServices = resolveComposeServices(services, available);
	} catch (cause) {
		if (cause instanceof ComposeTargetError) throw error(400, cause.message);
		throw cause;
	}
	if (inspection.ownership === 'other') {
		throw error(
			409,
			`Project "${inspection.projectName}" already has containers from ${inspection.otherWorkingDirs.join(', ')}. ` +
				'Stop that stack from its own repository, or give this sandbox another project name.'
		);
	}
	try {
		const run = startComposeRun(
			randomUUID(),
			target,
			repoName.trim(),
			inspection.projectName,
			action,
			selectedServices
		);
		return json({ id: run.id, repoPath: run.repoPath, projectName: inspection.projectName });
	} catch (cause) {
		if (cause instanceof ComposeRunConflict) throw error(409, cause.message);
		throw error(503, 'Could not start Compose. Check terminal capacity.');
	}
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');
	const { id } = body as Record<string, unknown>;
	if (typeof id !== 'string' || !id.trim()) throw error(400, 'id is required');
	await removeComposeRun(id.trim());
	return json({ success: true });
};
