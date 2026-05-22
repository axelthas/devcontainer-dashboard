import { json, error } from '@sveltejs/kit';
import { existsSync } from 'node:fs';
import { getActiveProvider, expandHome } from '$lib/server/bootstrap';
import { gitPull, readGitHead } from '$lib/server/git';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
	const provider = await getActiveProvider();
	if (!provider) {
		throw error(404, 'No bootstrap provider configured');
	}

	const repoPath = expandHome(provider.repoPath);
	if (!existsSync(repoPath)) {
		throw error(404, 'Bootstrap repository not found');
	}

	try {
		const output = await gitPull(repoPath);
		const currentBranch = await readGitHead(repoPath);
		return json({ success: true, output, currentBranch });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		throw error(500, message);
	}
};
