import { json, error } from '@sveltejs/kit';
import { validateRepoPath } from '$lib/server/repoPath';
import { gitFailureMessage, gitPullFastForward, listRefs, readGitHead } from '$lib/server/git';
import type { RequestHandler } from './$types';

/**
 * Fast-forward the checked-out branch from its upstream.
 * Refuses a detached HEAD and a branch without an upstream before Git runs.
 */
export const POST: RequestHandler = async ({ request }) => {
	const { path } = await request.json();
	const repoPath = validateRepoPath(path);

	const currentBranch = await readGitHead(repoPath);
	if (!currentBranch) {
		throw error(409, 'HEAD is detached. Check out a branch before you pull.');
	}
	let upstream: string | undefined;
	try {
		upstream = (await listRefs(repoPath)).local.find((b) => b.name === currentBranch)?.upstream;
	} catch (cause) {
		throw error(500, gitFailureMessage(cause));
	}
	if (!upstream) {
		throw error(
			409,
			`Branch "${currentBranch}" has no upstream. Push it or set an upstream first.`
		);
	}

	try {
		const output = await gitPullFastForward(repoPath);
		return json({ success: true, output, currentBranch, upstream });
	} catch (cause) {
		// Diverged branches and conflicting local changes are refusals, not server faults.
		throw error(409, gitFailureMessage(cause));
	}
};
