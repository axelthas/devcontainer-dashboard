import { json } from '@sveltejs/kit';
import { existsSync } from 'node:fs';
import { getActiveProvider, loadBootstrapProviders, expandHome } from '$lib/server/bootstrap';
import { readGitHead, listLocalBranches, gitDescribe } from '$lib/server/git';
import type { RequestHandler } from './$types';
import type { BootstrapToolInfo } from '$lib/types';

export const GET: RequestHandler = async ({ url }) => {
	const providerId = url.searchParams.get('provider');

	let providers = await loadBootstrapProviders();
	let provider = providerId
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

	const [currentBranch, availableBranches, version] = await Promise.all([
		readGitHead(repoPath),
		listLocalBranches(repoPath),
		gitDescribe(repoPath)
	]);

	const info: BootstrapToolInfo = {
		installed: true,
		currentBranch,
		availableBranches,
		version,
		repoPath
	};

	return json(info);
};
