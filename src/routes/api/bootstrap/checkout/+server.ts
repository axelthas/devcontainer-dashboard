import { json, error } from '@sveltejs/kit';
import { existsSync } from 'node:fs';
import { getActiveProvider, expandHome } from '$lib/server/bootstrap';
import { listLocalBranches, gitCheckout, readGitHead } from '$lib/server/git';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const { branch } = await request.json();

	if (typeof branch !== 'string' || !branch.trim()) {
		throw error(400, 'Branch name is required');
	}

	const provider = await getActiveProvider();
	if (!provider) {
		throw error(404, 'No bootstrap provider configured');
	}

	const repoPath = expandHome(provider.repoPath);
	if (!existsSync(repoPath)) {
		throw error(404, 'Bootstrap repository not found');
	}

	const availableBranches = await listLocalBranches(repoPath);
	if (!availableBranches.includes(branch)) {
		throw error(400, `Branch "${branch}" not found`);
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
