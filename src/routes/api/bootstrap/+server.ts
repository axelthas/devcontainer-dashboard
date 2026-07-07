import { json } from '@sveltejs/kit';
import { existsSync } from 'node:fs';
import { getActiveProvider, loadBootstrapProviders, expandHome } from '$lib/server/bootstrap';
import { readGitHead, listLocalBranches, listRemoteBranches, gitDescribe } from '$lib/server/git';
import type { RequestHandler } from './$types';
import type { BootstrapToolInfo } from '$lib/types';

export const GET: RequestHandler = async ({ url }) => {
	const providerId = url.searchParams.get('provider');

	const providers = await loadBootstrapProviders();
	const provider = providerId
		? providers.find((p) => p.id === providerId)
		: await getActiveProvider();

	if (!provider) {
		const info: BootstrapToolInfo = { installed: false, repoPath: '' };
		return json(info);
	}

	const repoPath = expandHome(provider.repoPath);
	const installed = existsSync(repoPath);

	if (!installed) {
		const info: BootstrapToolInfo = { installed: false, repoPath };
		return json(info);
	}

	const [currentBranch, availableBranches, remoteBranches, version] = await Promise.all([
		readGitHead(repoPath),
		listLocalBranches(repoPath),
		listRemoteBranches(repoPath),
		gitDescribe(repoPath)
	]);

	const info: BootstrapToolInfo = {
		installed: true,
		currentBranch,
		availableBranches,
		remoteBranches,
		version,
		repoPath
	};

	return json(info);
};
