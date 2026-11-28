/** Preview and remove one instance. Volumes, images and source files stay. */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import docker from '$lib/server/docker';
import { removalDocker } from '$lib/server/composeRemoval';
import { previewInstanceRemoval, removeManagedInstance } from '$lib/server/composeInstanceRemoval';
import { instanceHttpStatus } from '$lib/server/composeInstanceService';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const { directory: _directory, ...preview } = await previewInstanceRemoval(
			removalDocker(docker),
			WORKSPACE_ROOT,
			url.searchParams.get('project') ?? ''
		);
		void _directory;
		return json(preview, { headers: { 'cache-control': 'no-store' } });
	} catch (cause) {
		const mapped = instanceHttpStatus(cause);
		throw error(mapped.status, mapped.message);
	}
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');
	const { project, token } = body as Record<string, unknown>;
	try {
		return json(
			await removeManagedInstance(
				removalDocker(docker),
				WORKSPACE_ROOT,
				String(project ?? ''),
				token
			)
		);
	} catch (cause) {
		const mapped = instanceHttpStatus(cause);
		throw error(mapped.status, mapped.message);
	}
};
