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

	// Service ports are same-site but cross-origin. Cookies do not provide CSRF protection.
	// In this opt-in mode reject sibling-origin writes and non-navigation reads before auth.
	if (process.env.TAILSCALE_SOCKET) {
		const origin = event.request.headers.get('origin');
		const site = event.request.headers.get('sec-fetch-site');
		const navigation = event.request.headers.get('sec-fetch-mode') === 'navigate';
		const write = !['GET', 'HEAD', 'OPTIONS'].includes(event.request.method);
		if (
			event.request.headers.has('service-worker') ||
			(origin && origin !== process.env.ORIGIN) ||
			(write && origin !== process.env.ORIGIN) ||
			(!origin && site && !['same-origin', 'none'].includes(site) && !navigation)
		) {
			return new Response('Dashboard origin required', { status: 403 });
		}
	}

	if (isPublicPath(event.url.pathname)) return resolve(event);
	const sessionToken = event.cookies.get(AUTH_COOKIE_NAME);
	if (isSessionValid(sessionToken)) return resolve(event);
	if (event.url.pathname.startsWith('/api/')) return unauthorizedApiResponse();
	const next = `${event.url.pathname}${event.url.search}`;
	const location = `/login?${new URLSearchParams({ next })}`;
	return new Response(null, { status: 303, headers: { Location: location } });
};
