import { json, error } from '@sveltejs/kit';
import { validateRepoPath } from '$lib/server/repoPath';
import {
	gitFailureMessage,
	listLocalBranches,
	listRefs,
	listTags,
	readGitHead,
	readCurrentTag
} from '$lib/server/git';
import type { GitRefs, RepoRefsResponse } from '$lib/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const repoPath = validateRepoPath(url.searchParams.get('path'));

	try {
		const [branches, tags, currentBranch] = await Promise.all([
			listLocalBranches(repoPath),
			listTags(repoPath),
			readGitHead(repoPath)
		]);
		const currentTag = !currentBranch ? await readCurrentTag(repoPath) : undefined;
		// The ordered refs need the git binary. The name lists above do not, so they stay
		// available as a fallback when git refuses the repository (for example safe.directory).
		let refs: GitRefs | undefined;
		let refsError: string | undefined;
		try {
			refs = await listRefs(repoPath);
		} catch (cause) {
			refsError = gitFailureMessage(cause);
		}
		const body: RepoRefsResponse = { branches, tags, currentBranch, currentTag, refs, refsError };
		return json(body);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		throw error(500, message);
	}
};
