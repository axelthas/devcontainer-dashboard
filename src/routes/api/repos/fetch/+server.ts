import { json, error } from '@sveltejs/kit';
import { validateRepoPath } from '$lib/server/repoPath';
import { gitFailureMessage, gitFetch } from '$lib/server/git';
import type { RequestHandler } from './$types';

/** Fetch all remotes of one repository and prune deleted remote-tracking branches. */
export const POST: RequestHandler = async ({ request }) => {
	const { path } = await request.json();
	const repoPath = validateRepoPath(path);
	try {
		const output = await gitFetch(repoPath);
		return json({ success: true, output });
	} catch (cause) {
		throw error(502, gitFailureMessage(cause));
	}
};
