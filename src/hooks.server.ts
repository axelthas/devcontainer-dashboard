import { AUTH_COOKIE_NAME, assertAuthConfigured, isSessionValid } from '$lib/server/auth';
import { isDashboardRequestAllowed } from '$lib/server/dashboardRequestPolicy.js';
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

/** Prevent origin-separated services from embedding the operator dashboard. */
function protect(response: Response): Response {
	const result = new Response(response.body, response);
	result.headers.set('X-Frame-Options', 'DENY');
	result.headers.append('Content-Security-Policy', "frame-ancestors 'none'");
	result.headers.set('Referrer-Policy', 'no-referrer');
	result.headers.set('Cache-Control', 'no-store');
	return result;
}

export const handle: Handle = async ({ event, resolve }) => {
	assertAuthConfigured();

	if (!isDashboardRequestAllowed(
		event.request.method, event.request.headers, process.env.ORIGIN || event.url.origin
	)) {
		return protect(new Response('Dashboard origin required', { status: 403 }));
	}
	if (isPublicPath(event.url.pathname)) return protect(await resolve(event));

	const sessionToken = event.cookies.get(AUTH_COOKIE_NAME);
	if (isSessionValid(sessionToken)) return protect(await resolve(event));

	if (event.url.pathname.startsWith('/api/')) return protect(unauthorizedApiResponse());

	const next = `${event.url.pathname}${event.url.search}`;
	const location = `/login?${new URLSearchParams({ next })}`;
	return protect(new Response(null, { status: 303, headers: { Location: location } }));
};
