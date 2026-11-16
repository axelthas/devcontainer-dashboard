/** Browse any workspace directory, not only folders discovered as Git repositories. */
import { error } from '@sveltejs/kit';
import { aiFolders } from '$lib/server/aiPaths';
import { aiStatus } from '$lib/server/aiRuntime';
import { validAiId } from '$lib/server/aiSessions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const root = process.env.WORKSPACE_ROOT ?? '/workspaces';
	const tool = url.searchParams.get('tool');
	const launch = url.searchParams.get('launch');
	if (tool !== null && ((tool !== 'opencode' && tool !== 'openchamber') || !validAiId(launch)))
		error(400, 'Open a new AI window from the dashboard.');
	try {
		return {
			folders: await aiFolders(root, url.searchParams.get('path') ?? root),
			status: aiStatus(),
			vscodeSshHost: process.env.VSCODE_SSH_HOST ?? '',
			viewer: tool === 'opencode' || tool === 'openchamber' ? { tool, launch: launch! } : null
		};
	} catch {
		error(400, 'Select a readable directory inside the mounted workspace.');
	}
};
