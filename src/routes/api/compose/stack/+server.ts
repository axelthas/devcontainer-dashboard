/** Describe one Docker Services project for its presenter. Kind metadata only, never config. */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { describeStack, instanceHttpStatus } from '$lib/server/composeInstanceService';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';

export const GET: RequestHandler = async ({ url }) => {
	try {
		return json(await describeStack(WORKSPACE_ROOT, url.searchParams.get('project')), {
			headers: { 'cache-control': 'no-store' }
		});
	} catch (cause) {
		const mapped = instanceHttpStatus(cause);
		throw error(mapped.status, mapped.message);
	}
};
