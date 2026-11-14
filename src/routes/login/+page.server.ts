import { AUTH_COOKIE_NAME, createSession, validatePassword } from '$lib/server/auth';
import { safeRedirectTarget } from '$lib/server/requestPolicy';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => ({
	next: safeRedirectTarget(url.searchParams.get('next'))
});
export const actions: Actions = {
	default: async ({ cookies, getClientAddress, request, url }) => {
		const form = await request.formData();
		const password = form.get('password');
		const next = safeRedirectTarget(form.get('next'));
		if (typeof password !== 'string') return fail(400, { message: 'Invalid password', next });
		const result = await validatePassword(password, getClientAddress());
		if (result === 'throttled')
			return fail(429, { message: 'Too many attempts. Try again in one minute.', next });
		if (result === 'invalid') return fail(400, { message: 'Invalid password', next });
		cookies.set(AUTH_COOKIE_NAME, createSession(), {
			httpOnly: true,
			path: '/',
			sameSite: 'strict',
			secure: url.protocol === 'https:'
		});
		redirect(303, next);
	}
};
