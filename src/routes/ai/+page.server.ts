/** Folder browser for both AI interfaces, including directories without Git metadata. */
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { aiFolders } from '$lib/server/localAiPaths';
import { localAiStatus } from '$lib/server/localAi';

export const load: PageServerLoad = async ({ url }) => {
	const root = process.env.WORKSPACE_ROOT ?? '/workspaces';
	try {
		return { folders: await aiFolders(root, url.searchParams.get('path') ?? root), ai: localAiStatus() };
	} catch {
		error(400, 'Cannot open that directory. Select a readable folder inside the workspace root.');
	}
};
