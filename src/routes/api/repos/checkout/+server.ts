import { json, error } from '@sveltejs/kit';
import { validateRepoPath } from '$lib/server/repoPath';
import {
	listLocalBranches,
	listRemoteRefs,
	listTags,
	gitCheckout,
	gitCheckoutRemote,
	gitCheckoutTag,
	gitFailureMessage,
	isWorkingTreeDirty,
	readGitHead,
	readCurrentTag
} from '$lib/server/git';
import type { RequestHandler } from './$types';

/**
 * Check out a local branch (`branch`), a remote-tracking branch (`remote`, for example
 * `origin/feat/x`) or a tag (`tag`). A remote branch whose name already exists locally
 * checks out the local branch. A dirty working tree needs `force`.
 */
export const POST: RequestHandler = async ({ request }) => {
	const { path, branch, tag, remote, force } = await request.json();

	const repoPath = validateRepoPath(path);

	const ref = branch || tag || remote;
	if (typeof ref !== 'string' || !ref.trim()) {
		throw error(400, 'Branch or tag name is required');
	}

	// Validate ref against known branches and tags
	const [availableBranches, availableTags] = await Promise.all([
		listLocalBranches(repoPath),
		listTags(repoPath)
	]);

	let localTarget: string | undefined;
	let remoteTarget: string | undefined;
	let tagTarget: string | undefined;
	if (remote) {
		const remotes = await listRemoteRefs(repoPath).catch((cause) => {
			throw error(500, gitFailureMessage(cause));
		});
		const match = remotes.find((r) => r.name === remote);
		if (!match) throw error(400, `Remote branch "${remote}" not found in repository`);
		if (availableBranches.includes(match.branch)) localTarget = match.branch;
		else remoteTarget = match.name;
	} else if (availableBranches.includes(ref)) {
		localTarget = ref;
	} else if (availableTags.includes(ref)) {
		tagTarget = ref;
	} else {
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
		if (localTarget) await gitCheckout(repoPath, localTarget, availableBranches);
		else if (remoteTarget) await gitCheckoutRemote(repoPath, remoteTarget);
		else if (tagTarget) await gitCheckoutTag(repoPath, tagTarget);
		const currentBranch = await readGitHead(repoPath);
		const currentTag = !currentBranch ? await readCurrentTag(repoPath) : undefined;
		return json({ success: true, currentBranch, currentTag });
	} catch (err: unknown) {
		throw error(500, gitFailureMessage(err));
	}
};
