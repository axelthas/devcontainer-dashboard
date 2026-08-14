import { AUTH_COOKIE_NAME, assertAuthConfigured, isSessionValid } from '$lib/server/auth';
import type { Handle } from '@sveltejs/kit';

const PUBLIC_PATHS = new Set(['/login', '/robots.txt']);

function isPublicPath(pathname: string): boolean {
	return PUBLIC_PATHS.has(pathname) || pathname.startsWith('/_app/');
}

function unauthorizedApiResponse(): Response {
	return new Response(JSON.stringify({ message: 'Authentication required' }), {
		status: 401,
		headers: { 'Content-Type': 'application/json' }
	});
}

export const handle: Handle = async ({ event, resolve }) => {
	assertAuthConfigured();

	if (isPublicPath(event.url.pathname)) return resolve(event);

	const sessionToken = event.cookies.get(AUTH_COOKIE_NAME);
	if (isSessionValid(sessionToken)) return resolve(event);

	if (event.url.pathname.startsWith('/api/')) return unauthorizedApiResponse();

	const next = `${event.url.pathname}${event.url.search}`;
	const location = `/login?${new URLSearchParams({ next })}`;
	return new Response(null, { status: 303, headers: { Location: location } });
};
