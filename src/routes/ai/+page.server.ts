/** Folder browser for both AI interfaces, including directories without Git metadata. */
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { aiFolders } from '$lib/server/localAiPaths';
import { localAiStatus } from '$lib/server/localAi';
import { validAiLaunch } from '$lib/server/localAiSession';

export const load: PageServerLoad = async ({ url }) => {
	const root = process.env.WORKSPACE_ROOT ?? '/workspaces';
	const tool = url.searchParams.get('tool');
	const launch = url.searchParams.get('launch');
	const ai = localAiStatus();
	if (
		tool !== null &&
		((tool !== 'opencode' && tool !== 'openchamber') || !validAiLaunch(launch))
	) {
		error(400, 'Invalid service window. Open it from the dashboard.');
	}
	const viewer =
		tool === 'opencode' || tool === 'openchamber'
			? { tool, launch: launch!, instance: url.searchParams.get('instance') ?? ai.instance }
			: null;
	try {
		return { folders: await aiFolders(root, url.searchParams.get('path') ?? root), ai, viewer };
	} catch {
		error(400, 'Cannot open that directory. Select a readable folder inside the workspace root.');
	}
};
