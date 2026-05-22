import { json, error } from '@sveltejs/kit';
import { WORKSPACE_ROOT } from '$lib/server/workspaces';
import { listLocalBranches, gitCheckout, isWorkingTreeDirty, readGitHead } from '$lib/server/git';
import type { RequestHandler } from './$types';

function validateRepoPath(path: unknown): string {
	if (typeof path !== 'string' || !path.startsWith(WORKSPACE_ROOT + '/')) {
		throw error(400, 'Invalid repository path');
	}
	const normalized = new URL('file://' + path).pathname;
	if (!normalized.startsWith(WORKSPACE_ROOT + '/')) {
		throw error(400, 'Invalid repository path');
	}
	return normalized;
}

export const POST: RequestHandler = async ({ request }) => {
	const { path, branch, force } = await request.json();

	const repoPath = validateRepoPath(path);

	if (typeof branch !== 'string' || !branch.trim()) {
		throw error(400, 'Branch name is required');
	}

	// Validate branch against known branches
	const availableBranches = await listLocalBranches(repoPath);
	if (!availableBranches.includes(branch)) {
		throw error(400, `Branch "${branch}" not found in repository`);
	}

	// Check for dirty working tree unless force is set
	if (!force) {
		const dirty = await isWorkingTreeDirty(repoPath);
		if (dirty) {
			return json(
				{ success: false, error: 'dirty', message: 'Working tree has uncommitted changes' },
				{ status: 409 }
			);
		}
	}

	try {
		await gitCheckout(repoPath, branch, availableBranches);
		const currentBranch = await readGitHead(repoPath);
		return json({ success: true, currentBranch });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		throw error(500, message);
	}
};
