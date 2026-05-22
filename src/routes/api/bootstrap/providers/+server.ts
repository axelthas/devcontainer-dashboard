import { json } from '@sveltejs/kit';
import { loadBootstrapProviders, getActiveProvider } from '$lib/server/bootstrap';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	let providers = await loadBootstrapProviders();

	// If no providers file exists, check for default fallback
	if (providers.length === 0) {
		const fallback = await getActiveProvider();
		if (fallback) providers = [fallback];
	}

	return json(providers);
};
