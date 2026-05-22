import { json, error } from '@sveltejs/kit';
import { WORKSPACE_ROOT } from '$lib/server/workspaces';
import { listLocalBranches, listTags, gitCheckout, gitCheckoutTag, isWorkingTreeDirty, readGitHead, readCurrentTag } from '$lib/server/git';
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
	const { path, branch, tag, force } = await request.json();

	const repoPath = validateRepoPath(path);

	const ref = branch || tag;
	if (typeof ref !== 'string' || !ref.trim()) {
		throw error(400, 'Branch or tag name is required');
	}

	// Validate ref against known branches and tags
	const [availableBranches, availableTags] = await Promise.all([
		listLocalBranches(repoPath),
		listTags(repoPath)
	]);

	const isBranch = availableBranches.includes(ref);
	const isTag = availableTags.includes(ref);

	if (!isBranch && !isTag) {
		throw error(400, `Ref "${ref}" not found in repository`);
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
		if (isBranch) {
			await gitCheckout(repoPath, ref, availableBranches);
		} else {
			// Checkout tag (detached HEAD)
			await gitCheckoutTag(repoPath, ref);
		}
		const currentBranch = await readGitHead(repoPath);
		const currentTag = !currentBranch ? await readCurrentTag(repoPath) : undefined;
		return json({ success: true, currentBranch, currentTag });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		throw error(500, message);
	}
};
