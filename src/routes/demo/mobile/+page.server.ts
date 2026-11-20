/** Authenticated, opt-in fixture page. Disabled in ordinary deployments. */
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = () => {
	if (process.env.MOBILE_LAYOUT_FIXTURES !== '1') error(404, 'Not found');
	return {};
};
