import { AUTH_COOKIE_NAME, revokeSession } from '$lib/server/auth';
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ cookies, url }) => {
	revokeSession(cookies.get(AUTH_COOKIE_NAME));
	cookies.delete(AUTH_COOKIE_NAME, {
		path: '/',
		secure: url.protocol === 'https:'
	});
	redirect(303, '/login');
};
