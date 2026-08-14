import { AUTH_COOKIE_NAME, createSession, validatePassword } from '$lib/server/auth';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

function safeRedirectTarget(value: FormDataEntryValue | string | null): string {
	if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
	return value;
}

export const load: PageServerLoad = ({ url }) => ({
	next: safeRedirectTarget(url.searchParams.get('next'))
});

export const actions: Actions = {
	default: async ({ cookies, getClientAddress, request, url }) => {
		const formData = await request.formData();
		const password = formData.get('password');
		const next = safeRedirectTarget(formData.get('next'));

		if (typeof password !== 'string') {
			return fail(400, { message: 'Invalid password', next });
		}

		const result = validatePassword(password, getClientAddress());
		if (result === 'throttled') {
			return fail(429, { message: 'Too many attempts. Try again in one minute.', next });
		}
		if (result === 'invalid') {
			return fail(400, { message: 'Invalid password', next });
		}

		cookies.set(AUTH_COOKIE_NAME, createSession(), {
			httpOnly: true,
			path: '/',
			sameSite: 'strict',
			secure: url.protocol === 'https:'
		});

		redirect(303, next);
	}
};
