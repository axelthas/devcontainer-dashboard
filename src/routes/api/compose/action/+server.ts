/** Run one declared kind action. The request names the action and option only, never argv. */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import docker from '$lib/server/docker';
import { resolveComposeTarget } from '$lib/server/composeSandbox';
import { instanceHttpStatus, runKindAction } from '$lib/server/composeInstanceService';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');
	const { repoPath, files, envFile, profiles, tag, instance, action, option, confirmed } =
		body as Record<string, unknown>;
	try {
		const target = await resolveComposeTarget(WORKSPACE_ROOT, {
			repoPath,
			files,
			envFile,
			profiles,
			tag
		});
		return json(
			await runKindAction({
				client: docker as never,
				workspaceRoot: WORKSPACE_ROOT,
				target,
				...(instance === undefined ? {} : { instance: String(instance) }),
				action,
				option,
				confirmed
			})
		);
	} catch (cause) {
		const mapped = instanceHttpStatus(cause);
		throw error(mapped.status, mapped.message);
	}
};
