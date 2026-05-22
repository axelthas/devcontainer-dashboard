import { json, error } from '@sveltejs/kit';
import { WORKSPACE_ROOT } from '$lib/server/workspaces';
import { listLocalBranches, listTags, readGitHead, readCurrentTag } from '$lib/server/git';
import type { RequestHandler } from './$types';

function validateRepoPath(path: string | null): string {
	if (typeof path !== 'string' || !path.startsWith(WORKSPACE_ROOT + '/')) {
		throw error(400, 'Invalid repository path');
	}
	const normalized = new URL('file://' + path).pathname;
	if (!normalized.startsWith(WORKSPACE_ROOT + '/')) {
		throw error(400, 'Invalid repository path');
	}
	return normalized;
}

export const GET: RequestHandler = async ({ url }) => {
	const repoPath = validateRepoPath(url.searchParams.get('path'));

	try {
		const [branches, tags, currentBranch] = await Promise.all([
			listLocalBranches(repoPath),
			listTags(repoPath),
			readGitHead(repoPath)
		]);
		const currentTag = !currentBranch ? await readCurrentTag(repoPath) : undefined;
		return json({ branches, tags, currentBranch, currentTag });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		throw error(500, message);
	}
};
