import { redirect } from '@sveltejs/kit';
import { loadDashboardData } from '$lib/server/dashboardData';
import { INTERFACE_COOKIE_NAME, preferredInterface } from '$lib/interfacePreference';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies, request }) => {
	// Phones get the dedicated mobile interface unless the operator chose the desktop one.
	const choice = preferredInterface(
		cookies.get(INTERFACE_COOKIE_NAME),
		request.headers.get('user-agent')
	);
	if (choice === 'mobile') redirect(307, '/mobile');
	return loadDashboardData();
};
