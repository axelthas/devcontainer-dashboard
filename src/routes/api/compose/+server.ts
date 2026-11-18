/** Resolve a Compose selection and report its structure and live stack ownership. */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import docker from '$lib/server/docker';
import {
	ComposeConfigError,
	ComposeTargetError,
	ComposeUnavailableError,
	inspectComposeTarget,
	resolveComposeTarget
} from '$lib/server/composeSandbox';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';

/** Map expected failures to status codes; never leak unexpected internals. */
function composeHttpError(cause: unknown): never {
	if (cause instanceof ComposeTargetError) throw error(400, cause.message);
	if (cause instanceof ComposeConfigError) throw error(422, cause.message);
	if (cause instanceof ComposeUnavailableError) throw error(503, cause.message);
	throw error(503, 'Could not inspect the Compose configuration. Check Docker availability.');
}

export const GET: RequestHandler = async ({ url }) => {
	try {
		const target = await resolveComposeTarget(WORKSPACE_ROOT, {
			repoPath: url.searchParams.get('repoPath') ?? undefined,
			files: url.searchParams.getAll('file'),
			envFile: url.searchParams.get('envFile') ?? undefined,
			profiles: url.searchParams.getAll('profile')
		});
		const inspection = await inspectComposeTarget(target, (options) =>
			docker.listContainers(options)
		);
		return json(inspection, { headers: { 'cache-control': 'no-store' } });
	} catch (cause) {
		composeHttpError(cause);
	}
};
