/** Preview and remove a whole Compose sandbox. Volumes, images, and source files stay. */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import docker from '$lib/server/docker';
import {
	previewSandboxRemoval,
	removalDocker,
	RemovalInputError,
	RemovalNotFoundError,
	RemovalStaleError,
	removeSandbox
} from '$lib/server/composeRemoval';
import { ComposeRunConflict } from '$lib/server/composeRuns';

/** Map expected failures to status codes; never leak unexpected internals. */
function removalHttpError(cause: unknown): never {
	if (cause instanceof RemovalInputError) throw error(400, cause.message);
	if (cause instanceof RemovalNotFoundError) throw error(404, cause.message);
	if (cause instanceof RemovalStaleError) throw error(409, cause.message);
	if (cause instanceof ComposeRunConflict) {
		throw error(
			409,
			'A Compose operation or removal is running for this sandbox. Try again after it ends.'
		);
	}
	throw error(503, 'Could not read the sandbox from Docker. Check Docker availability.');
}

export const GET: RequestHandler = async ({ url }) => {
	try {
		const preview = await previewSandboxRemoval(
			removalDocker(docker),
			url.searchParams.get('project') ?? ''
		);
		return json(preview, { headers: { 'cache-control': 'no-store' } });
	} catch (cause) {
		removalHttpError(cause);
	}
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');
	const { project, token } = body as Record<string, unknown>;
	try {
		const results = await removeSandbox(removalDocker(docker), String(project ?? ''), token);
		return json({ results });
	} catch (cause) {
		removalHttpError(cause);
	}
};
