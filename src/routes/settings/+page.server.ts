/** Load only the redacted shared Settings view; sessions are enforced by hooks. */
import { readSettings } from '$lib/server/settings';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	return { settings: await readSettings() };
};
